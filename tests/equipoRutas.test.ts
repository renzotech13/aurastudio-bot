import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Pruebas de las rutas /equipo/* con Fastify de verdad y los repositorios
 * simulados. Lo que se comprueba no es que "funcione", sino que una
 * profesional NO pueda salirse de lo suyo: la cita de otra, una clienta que
 * no atendió, un servicio que no hace, la caja cuando está cerrada.
 */

const YO = "aaaaaaaa-1111-4bbb-8ccc-dddddddddddd";
const OTRA = "bbbbbbbb-2222-4ccc-8ddd-eeeeeeeeeeee";
const USUARIO = "cccccccc-3333-4ddd-8eee-ffffffffffff";
const CLIENTA = "dddddddd-4444-4eee-8fff-111111111111";
const CITA = "eeeeeeee-5555-4fff-8111-222222222222";

// ─── Simulaciones ───────────────────────────────────────────────────────────

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent" } }));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const requireProfesional = vi.fn();
vi.mock("../src/lib/adminAuth.js", () => ({ requireProfesional: (h: unknown) => requireProfesional(h) }));

const actualizarEstadoCita = vi.fn();
const crearCitasConsecutivas = vi.fn();
vi.mock("../src/db/repositories/citas.js", () => ({
  actualizarEstadoCita: (...a: unknown[]) => actualizarEstadoCita(...a),
  crearCitasConsecutivas: (...a: unknown[]) => crearCitasConsecutivas(...a),
}));

const findOrCreateByPhone = vi.fn();
const getClienteById = vi.fn();
vi.mock("../src/db/repositories/clientes.js", () => ({
  findOrCreateByPhone: (...a: unknown[]) => findOrCreateByPhone(...a),
  getClienteById: (...a: unknown[]) => getClienteById(...a),
}));

const getProfesionalEnSede = vi.fn();
vi.mock("../src/db/repositories/profesionales.js", () => ({
  getProfesionalEnSede: (...a: unknown[]) => getProfesionalEnSede(...a),
}));

const getCitaPorId = vi.fn();
const clienteEsDeProfesional = vi.fn();
const serviciosDeProfesional = vi.fn();
const cajaAbiertaEnSede = vi.fn();
const registrarVentaProducto = vi.fn();
vi.mock("../src/db/repositories/equipo.js", () => ({
  getCitaPorId: (...a: unknown[]) => getCitaPorId(...a),
  clienteEsDeProfesional: (...a: unknown[]) => clienteEsDeProfesional(...a),
  serviciosDeProfesional: (...a: unknown[]) => serviciosDeProfesional(...a),
  cajaAbiertaEnSede: (...a: unknown[]) => cajaAbiertaEnSede(...a),
  registrarVentaProducto: (...a: unknown[]) => registrarVentaProducto(...a),
}));

const { equipoRoutes } = await import("../src/routes/equipo.js");
const { AppError } = await import("../src/lib/errors.js");

// ─── Armado ─────────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  requireProfesional.mockResolvedValue({ id: USUARIO, email: "laura@aurastudio.pe", profesionalId: YO, nombre: "Laura" });
  serviciosDeProfesional.mockResolvedValue(new Set(["manicure-clasica", "esmaltado-en-gel"]));
  getProfesionalEnSede.mockResolvedValue({ id: YO, nombre: "Laura", dias: [] });
  clienteEsDeProfesional.mockResolvedValue(true);
  getClienteById.mockResolvedValue({ id: CLIENTA, nombre: "Rosa", telefono: "51987654321", notas: "alérgica al látex" });
  crearCitasConsecutivas.mockResolvedValue({
    ok: true,
    citas: [{ id: CITA, inicio_utc: "2026-09-26T15:00:00Z", fin_utc: "2026-09-26T15:30:00Z", estado: "completada", cliente_id: CLIENTA }],
  });

  app = Fastify();
  // El mismo mapeo que el manejador global de index.ts.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.code });
    return reply.status(500).send({ error: "internal_error" });
  });
  await app.register(equipoRoutes);
});

const ahoraLima = () => new Date().toISOString().replace("Z", "-00:00").replace("-00:00", "+00:00");
const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object, headers: { authorization: "Bearer x" } });

// ─── Quién puede entrar ─────────────────────────────────────────────────────

describe("acceso — las tres rutas exigen ser una profesional", () => {
  const rutas: [string, unknown][] = [
    [`/equipo/citas/${CITA}/estado`, { estado: "completada" }],
    ["/equipo/atencion", { cliente_id: CLIENTA, servicio_ids: ["manicure-clasica"], sede_id: "los-olivos", inicio: ahoraLima() }],
    ["/equipo/ventas", { sede_id: "los-olivos", concepto: "Champú", monto: 45 }],
  ];

  it.each(rutas)("%s sin sesión responde 401 y no toca la base", async (url, payload) => {
    requireProfesional.mockRejectedValue(new AppError("Falta el token", "missing_token", 401));
    const res = await post(url, payload);
    expect(res.statusCode).toBe(401);
    expect(actualizarEstadoCita).not.toHaveBeenCalled();
    expect(crearCitasConsecutivas).not.toHaveBeenCalled();
    expect(registrarVentaProducto).not.toHaveBeenCalled();
  });

  it.each(rutas)("%s con un usuario que no es profesional (p. ej. staff) responde 403", async (url, payload) => {
    requireProfesional.mockRejectedValue(new AppError("Se requiere rol profesional", "forbidden", 403));
    const res = await post(url, payload);
    expect(res.statusCode).toBe(403);
    expect(actualizarEstadoCita).not.toHaveBeenCalled();
    expect(crearCitasConsecutivas).not.toHaveBeenCalled();
    expect(registrarVentaProducto).not.toHaveBeenCalled();
  });

  it.each(rutas)("%s con una profesional desactivada responde 403", async (url, payload) => {
    requireProfesional.mockRejectedValue(new AppError("No enlazada", "profesional_inactiva", 403));
    expect((await post(url, payload)).statusCode).toBe(403);
  });
});

// ─── Marcar una cita ────────────────────────────────────────────────────────

describe("POST /equipo/citas/:id/estado", () => {
  it("marca una cita suya", async () => {
    getCitaPorId.mockResolvedValue({ id: CITA, estado: "confirmada", profesional_id: YO });
    actualizarEstadoCita.mockResolvedValue({ id: CITA, estado: "completada", cliente_id: CLIENTA, notas: "privado" });

    const res = await post(`/equipo/citas/${CITA}/estado`, { estado: "completada" });

    expect(res.statusCode).toBe(200);
    expect(actualizarEstadoCita).toHaveBeenCalledWith(CITA, "completada");
    // Respuesta mínima: no devuelve cliente_id ni notas de la fila.
    expect(res.json()).toEqual({ cita: { id: CITA, estado: "completada" } });
  });

  it("NO toca la cita de otra profesional, y responde como si no existiera", async () => {
    getCitaPorId.mockResolvedValue({ id: CITA, estado: "confirmada", profesional_id: OTRA });

    const res = await post(`/equipo/citas/${CITA}/estado`, { estado: "cancelada" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "cita_no_encontrada" });
    expect(actualizarEstadoCita).not.toHaveBeenCalled();
  });

  it("NO toca una cita sin profesional asignada", async () => {
    getCitaPorId.mockResolvedValue({ id: CITA, estado: "confirmada", profesional_id: null });
    expect((await post(`/equipo/citas/${CITA}/estado`, { estado: "completada" })).statusCode).toBe(404);
    expect(actualizarEstadoCita).not.toHaveBeenCalled();
  });

  it("una cita inexistente responde igual que una ajena", async () => {
    getCitaPorId.mockResolvedValue(null);
    const res = await post(`/equipo/citas/${CITA}/estado`, { estado: "completada" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "cita_no_encontrada" });
  });

  it("rechaza un estado inventado sin llegar a consultar la cita", async () => {
    const res = await post(`/equipo/citas/${CITA}/estado`, { estado: "borrada" });
    expect(res.statusCode).toBe(400);
    expect(getCitaPorId).not.toHaveBeenCalled();
  });
});

// ─── Atención sin reserva ───────────────────────────────────────────────────

describe("POST /equipo/atencion", () => {
  const cuerpo = (extra: object = {}) => ({
    cliente_id: CLIENTA,
    servicio_ids: ["manicure-clasica"],
    sede_id: "los-olivos",
    inicio: new Date().toISOString(),
    ...extra,
  });

  it("registra la atención a su nombre y devuelve solo lo mínimo", async () => {
    const res = await post("/equipo/atencion", cuerpo());

    expect(res.statusCode).toBe(201);
    expect(crearCitasConsecutivas).toHaveBeenCalledWith(
      expect.objectContaining({ profesionalId: YO, sedeId: "los-olivos", creadaPor: "humano" }),
    );
    // La respuesta de /admin/citas trae la clienta completa; esta, no.
    const cliente = res.json().cliente as Record<string, unknown>;
    expect(cliente).toEqual({ id: CLIENTA, nombre: "Rosa" });
    expect(cliente).not.toHaveProperty("telefono");
    expect(cliente).not.toHaveProperty("notas");
  });

  it("ignora un profesional_id del cuerpo: siempre queda a nombre de ella", async () => {
    await post("/equipo/atencion", cuerpo({ profesional_id: OTRA }));

    const llamada = crearCitasConsecutivas.mock.calls[0]![0] as { profesionalId: string };
    expect(llamada.profesionalId).toBe(YO);
    expect(getProfesionalEnSede).toHaveBeenCalledWith(YO, "los-olivos");
  });

  it("rechaza un servicio que ella no hace, y no crea nada", async () => {
    const res = await post("/equipo/atencion", cuerpo({ servicio_ids: ["manicure-clasica", "keratina"] }));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "servicio_no_permitido", servicio_id_fallido: "keratina" });
    expect(crearCitasConsecutivas).not.toHaveBeenCalled();
  });

  it("trata a una clienta ajena como inexistente", async () => {
    clienteEsDeProfesional.mockResolvedValue(false);

    const res = await post("/equipo/atencion", cuerpo());

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "cliente_no_encontrado" });
    expect(getClienteById).not.toHaveBeenCalled();
    expect(crearCitasConsecutivas).not.toHaveBeenCalled();
  });

  it("no puede anotar en un local donde no atiende", async () => {
    getProfesionalEnSede.mockResolvedValue(null);
    const res = await post("/equipo/atencion", cuerpo({ sede_id: "independencia" }));
    expect(res.statusCode).toBe(400);
    expect(crearCitasConsecutivas).not.toHaveBeenCalled();
  });

  it("rechaza anotar una atención de hace semanas", async () => {
    const haceUnMes = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    const res = await post("/equipo/atencion", cuerpo({ inicio: haceUnMes }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "fuera_de_rango" });
    expect(crearCitasConsecutivas).not.toHaveBeenCalled();
  });

  it("una clienta nueva se crea con el teléfono NORMALIZADO, para no duplicarla", async () => {
    findOrCreateByPhone.mockResolvedValue({ id: CLIENTA, nombre: "Ana Torres" });
    const nueva = { servicio_ids: ["manicure-clasica"], sede_id: "los-olivos", inicio: new Date().toISOString(), telefono: "987 654 321", nombre: "Ana Torres" };

    const res = await post("/equipo/atencion", nueva);

    expect(res.statusCode).toBe(201);
    expect(findOrCreateByPhone).toHaveBeenCalledWith("51987654321", "Ana Torres");
    // Sin cliente_id: no hay que comprobar que sea suya, todavía no existe.
    expect(clienteEsDeProfesional).not.toHaveBeenCalled();
  });

  it("rechaza un teléfono que no parece uno", async () => {
    const nueva = { servicio_ids: ["manicure-clasica"], sede_id: "los-olivos", inicio: new Date().toISOString(), telefono: "12345678a", nombre: "Ana Torres" };
    const res = await post("/equipo/atencion", { ...nueva, telefono: "abc def" });
    expect(res.statusCode).toBe(400);
    expect(findOrCreateByPhone).not.toHaveBeenCalled();
  });

  it("si el horario choca con otra cita, responde 409", async () => {
    crearCitasConsecutivas.mockResolvedValue({ ok: false, reason: "conflicto_horario", servicioIdFallido: "manicure-clasica" });
    const res = await post("/equipo/atencion", cuerpo());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "conflicto_horario" });
  });
});

// ─── Venta de un producto ───────────────────────────────────────────────────

describe("POST /equipo/ventas", () => {
  const venta = (extra: object = {}) => ({ sede_id: "los-olivos", concepto: "Champú sin sal", monto: 45, ...extra });

  it("anota un ingreso de producto en la caja abierta de su local, a su nombre", async () => {
    cajaAbiertaEnSede.mockResolvedValue({ id: "caja-1" });
    registrarVentaProducto.mockResolvedValue({ id: "mov-1" });

    const res = await post("/equipo/ventas", venta({ metodo: "yape" }));

    expect(res.statusCode).toBe(201);
    expect(cajaAbiertaEnSede).toHaveBeenCalledWith("los-olivos");
    expect(registrarVentaProducto).toHaveBeenCalledWith({
      sesionId: "caja-1",
      concepto: "Champú sin sal",
      monto: 45,
      metodo: "yape",
      profesionalId: YO,
      usuarioId: USUARIO,
    });
    expect(res.json()).toEqual({ movimiento: { id: "mov-1", concepto: "Champú sin sal", monto: 45 } });
  });

  it("sin caja abierta no anota nada: 409", async () => {
    cajaAbiertaEnSede.mockResolvedValue(null);

    const res = await post("/equipo/ventas", venta());

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "caja_cerrada" });
    expect(registrarVentaProducto).not.toHaveBeenCalled();
  });

  it("no puede anotar en la caja de un local donde no atiende", async () => {
    getProfesionalEnSede.mockResolvedValue(null);

    const res = await post("/equipo/ventas", venta({ sede_id: "independencia" }));

    expect(res.statusCode).toBe(400);
    expect(cajaAbiertaEnSede).not.toHaveBeenCalled();
    expect(registrarVentaProducto).not.toHaveBeenCalled();
  });

  it("rechaza un monto por encima del tope antes de mirar la caja", async () => {
    const res = await post("/equipo/ventas", venta({ monto: 4500 }));
    expect(res.statusCode).toBe(400);
    expect(cajaAbiertaEnSede).not.toHaveBeenCalled();
  });

  it("no acepta cambiar el tipo ni la categoría: solo ingreso de producto", async () => {
    cajaAbiertaEnSede.mockResolvedValue({ id: "caja-1" });
    registrarVentaProducto.mockResolvedValue({ id: "mov-1" });

    await post("/equipo/ventas", venta({ tipo: "egreso", categoria: "sueldo", sesion_id: "otra-caja" }));

    const llamada = registrarVentaProducto.mock.calls[0]![0] as Record<string, unknown>;
    expect(llamada).not.toHaveProperty("tipo");
    expect(llamada).not.toHaveProperty("categoria");
    expect(llamada.sesionId).toBe("caja-1");
  });
});
