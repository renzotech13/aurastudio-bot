import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env, whatsappConfigurado } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { requireStaff } from "../lib/adminAuth.js";
import { normalizarTelefono } from "../lib/telefono.js";
import { crearPlantilla, listarPlantillas, sendTemplate, type Plantilla } from "../whatsapp/client.js";
import { guardarMensaje } from "../db/repositories/mensajes.js";
import { getClienteByTelefono } from "../db/repositories/clientes.js";
import { reservarNotificacion, marcarEnviada, marcarFallida } from "../db/repositories/notificaciones.js";
import { calcularAudiencia, MOTIVOS } from "../campanias/audiencia.js";
import { PLANTILLAS_CAMPANIA, plantillaPorClave, nombreSaludo, cuerpoPara, fueraDeFecha } from "../campanias/plantillas.js";

/**
 * Campañas de WhatsApp desde el panel (como en B&B): cada plantilla definida en campanias/plantillas.ts se ve con su
 * estado en Meta, se manda a aprobar con un botón, se prueba en un número y se envía por lotes pequeños a su audiencia.
 * Nada sale solo. Cada envío queda en el chat de la clienta y como notificación (así no se le repite).
 */

const PAUSA_ENTRE_ENVIOS_MS = 1_200;
const MAX_POR_LOTE = 25;
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
let enviando = false;

const claveSchema = z.object({ clave: z.string().min(1) });
const enviarSchema = z.object({
  clave: z.string().min(1),
  limite: z.number().int().min(1).max(MAX_POR_LOTE).default(MAX_POR_LOTE),
  /** Prueba: solo a estos números, aunque estén fuera de la audiencia. No cuenta como envío de la campaña. */
  telefonos: z.array(z.string()).min(1).max(5).optional(),
});

function estadoEn(lista: Plantilla[], nombre: string): Plantilla["estado"] | null {
  return lista.find((p) => p.nombre === nombre)?.estado ?? null;
}

export async function campaniasRoutes(app: FastifyInstance) {
  /** Todas las plantillas de campaña con su estado en Meta, su audiencia (cuántas y quiénes) y las excluidas por motivo. */
  app.get("/admin/campanias", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);
    if (!whatsappConfigurado) return reply.status(409).send({ error: "whatsapp_no_configurado" });

    const lista = await listarPlantillas().catch((err) => {
      logger.error({ err }, "No se pudieron leer las plantillas de Meta para Campañas");
      return null;
    });
    const plantillas = await Promise.all(
      PLANTILLAS_CAMPANIA.map(async (def) => {
        const audiencia = await calcularAudiencia(def);
        return {
          clave: def.clave,
          nombre: def.nombre,
          titulo: def.titulo,
          descripcion: def.descripcion,
          categoria: def.categoria,
          cuerpo: def.cuerpo,
          pie: def.pie ?? null,
          botones: def.botones,
          automatica: def.audiencia === "automatica",
          estado: lista ? estadoEn(lista, def.nombre) : null,
          fueraDeFecha: def.audiencia === "automatica" ? null : fueraDeFecha(def),
          revisadas: audiencia.revisadas,
          alcanza: audiencia.destinatarios.length,
          excluidas: Object.entries(audiencia.excluidas)
            .filter(([, n]) => n > 0)
            .map(([motivo, n]) => ({ motivo: MOTIVOS[motivo as keyof typeof MOTIVOS], cantidad: n })),
          muestra: audiencia.destinatarios.slice(0, 30).map((d) => ({ nombre: d.nombre, telefono: d.telefono })),
        };
      }),
    );
    return reply.send({ metaDisponible: Boolean(lista), plantillas });
  });

  /** Manda UNA plantilla a Meta para que la apruebe. Si ya existe, solo devuelve su estado. */
  app.post("/admin/campanias/plantilla", async (request: FastifyRequest, reply: FastifyReply) => {
    const staff = await requireStaff(request.headers.authorization);
    const parsed = claveSchema.safeParse(request.body);
    const def = parsed.success ? plantillaPorClave(parsed.data.clave) : undefined;
    if (!def) return reply.status(400).send({ error: "invalid_body", mensaje: "Plantilla desconocida." });
    try {
      const actual = estadoEn(await listarPlantillas(), def.nombre);
      if (actual) return reply.send({ estado: actual, creada: false });
      const r = await crearPlantilla({
        nombre: def.nombre,
        categoria: def.categoria,
        idioma: env.WHATSAPP_TEMPLATE_LANG,
        cuerpo: def.cuerpo,
        ejemplos: def.ejemplos,
        ...(def.pie ? { pie: def.pie } : {}),
        botonesRespuesta: def.botones,
      });
      logger.info({ plantilla: def.nombre, estado: r.estado, por: staff.id }, "Plantilla de campaña enviada a Meta");
      return reply.send({ estado: r.estado, creada: true });
    } catch (err) {
      // 422 con el motivo de Meta: un 502 pelado no le dice nada a quien está en el panel.
      logger.error({ err, plantilla: def.nombre }, "No se pudo crear la plantilla de campaña");
      return reply.status(422).send({ error: "plantilla_fallida", mensaje: err instanceof Error ? err.message : "error desconocido" });
    }
  });

  /** Un lote de la campaña (máx. 25, con pausa entre envíos), o una prueba a uno a cinco números. */
  app.post("/admin/campanias/enviar", async (request: FastifyRequest, reply: FastifyReply) => {
    const staff = await requireStaff(request.headers.authorization);
    const parsed = enviarSchema.safeParse(request.body);
    const def = parsed.success ? plantillaPorClave(parsed.data.clave) : undefined;
    if (!parsed.success || !def) return reply.status(400).send({ error: "invalid_body", mensaje: "Plantilla desconocida." });
    const { limite, telefonos } = parsed.data;
    const prueba = Boolean(telefonos);

    if (!prueba && def.audiencia === "automatica") {
      return reply.status(409).send({ error: "solo_automatica", mensaje: "Esta plantilla la manda el bot sola; aquí solo se puede probar." });
    }
    const fecha = prueba ? null : fueraDeFecha(def);
    if (fecha) return reply.status(409).send({ error: "fuera_de_fecha", mensaje: fecha });
    if (enviando) return reply.status(409).send({ error: "envio_en_curso", mensaje: "Ya hay un lote saliendo. Espera a que termine." });

    const estado = estadoEn(await listarPlantillas(), def.nombre);
    if (estado !== "APPROVED") {
      return reply.status(409).send({
        error: "plantilla_no_aprobada",
        mensaje: `Meta todavía no aprueba esta plantilla (estado: ${estado ?? "no creada"}).`,
      });
    }

    enviando = true;
    try {
      let enviados = 0;
      const fallidos: { telefono: string; motivo: string }[] = [];

      if (prueba) {
        const numeros = [...new Set(telefonos!.map((t) => normalizarTelefono(t)).filter((t): t is string => Boolean(t)))];
        if (numeros.length === 0) return reply.status(400).send({ error: "telefono_invalido" });
        for (const telefono of numeros) {
          const cliente = await getClienteByTelefono(telefono).catch(() => null);
          const parametros = def.audiencia === "automatica" ? def.ejemplos : [nombreSaludo(cliente?.nombre ?? "Prueba")];
          try {
            await sendTemplate({ to: telefono, plantilla: def.nombre, idioma: env.WHATSAPP_TEMPLATE_LANG, parametros });
            enviados++;
          } catch (err) {
            fallidos.push({ telefono, motivo: err instanceof Error ? err.message : String(err) });
          }
          await pausa(PAUSA_ENTRE_ENVIOS_MS);
        }
        logger.info({ plantilla: def.nombre, enviados, por: staff.id }, "Prueba de plantilla de campaña");
        return reply.send({ enviados, fallidos, quedan: 0 });
      }

      const audiencia = await calcularAudiencia(def);
      const lote = audiencia.destinatarios.slice(0, limite);
      for (const d of lote) {
        // La notificación se reserva antes de mandar: si dos lotes se cruzaran, la audiencia del segundo ya la excluye.
        const notificacion = await reservarNotificacion({ clienteId: d.clienteId, tipo: "promocion", plantilla: def.nombre });
        if (!notificacion) continue;
        const parametros = [nombreSaludo(d.nombre)];
        try {
          const externalId = await sendTemplate({ to: d.telefono, plantilla: def.nombre, idioma: env.WHATSAPP_TEMPLATE_LANG, parametros });
          await marcarEnviada(notificacion.id);
          if (d.conversacionId) {
            await guardarMensaje({
              conversacionId: d.conversacionId,
              rol: "assistant",
              contenido: cuerpoPara(def, parametros),
              externalId,
              waMessageId: externalId,
              metadata: { campana: def.clave, via: "plantilla", plantilla: def.nombre, botones: def.botones },
            }).catch((err) => logger.warn({ err, clienteId: d.clienteId }, "No se pudo guardar la campaña en el chat"));
          }
          enviados++;
        } catch (err) {
          const motivo = err instanceof Error ? err.message : String(err);
          await marcarFallida(notificacion.id, motivo).catch(() => {});
          fallidos.push({ telefono: d.telefono, motivo });
          logger.error({ err, clienteId: d.clienteId }, "Falló un envío de campaña");
        }
        await pausa(PAUSA_ENTRE_ENVIOS_MS);
      }
      logger.info({ plantilla: def.nombre, enviados, fallidos: fallidos.length, por: staff.id }, "Lote de campaña");
      return reply.send({ enviados, fallidos, quedan: Math.max(audiencia.destinatarios.length - lote.length, 0) });
    } finally {
      enviando = false;
    }
  });
}
