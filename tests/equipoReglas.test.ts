import { describe, expect, it } from "vitest";
import {
  HORAS_ADELANTE,
  HORAS_ATRAS,
  MAX_VENTA_SOLES,
  atencionSchema,
  citaEsDeProfesional,
  estadoSchema,
  inicioEnRango,
  serviciosNoPermitidos,
  ventaSchema,
} from "../src/lib/equipoReglas.js";

const YO = "aaaaaaaa-1111-4bbb-8ccc-dddddddddddd";
const OTRA = "22222222-2222-4222-8222-222222222222";
const CLIENTA = "33333333-3333-4333-8333-333333333333";

describe("citaEsDeProfesional — de quién es una cita", () => {
  it("es suya solo si la cita tiene su id", () => {
    expect(citaEsDeProfesional(YO, YO)).toBe(true);
  });

  it("no es suya si es de otra profesional", () => {
    expect(citaEsDeProfesional(OTRA, YO)).toBe(false);
  });

  it("una cita sin profesional asignada no es de nadie", () => {
    // Las anteriores a la migración 0014 no traen profesional_id. Que
    // «null !== id» sea falso es justo lo que se está comprobando.
    expect(citaEsDeProfesional(null, YO)).toBe(false);
    expect(citaEsDeProfesional(undefined, YO)).toBe(false);
  });

  it("no coincide con un id vacío ni parecido", () => {
    expect(citaEsDeProfesional("", YO)).toBe(false);
    expect(citaEsDeProfesional(YO.toUpperCase(), YO)).toBe(false);
  });
});

describe("inicioEnRango — cuándo puede anotar una atención", () => {
  const ahora = new Date("2026-09-26T15:00:00Z");
  const desplazada = (horas: number) => new Date(ahora.getTime() + horas * 3_600_000);

  it("acepta lo que está pasando ahora", () => {
    expect(inicioEnRango(ahora, ahora)).toBe(true);
  });

  it("acepta lo de hace un rato y lo de más tarde hoy", () => {
    expect(inicioEnRango(desplazada(-3), ahora)).toBe(true);
    expect(inicioEnRango(desplazada(5), ahora)).toBe(true);
  });

  it("acepta justo los bordes de la ventana", () => {
    expect(inicioEnRango(desplazada(-HORAS_ATRAS), ahora)).toBe(true);
    expect(inicioEnRango(desplazada(HORAS_ADELANTE), ahora)).toBe(true);
  });

  it("rechaza pasar un minuto de la ventana, hacia atrás y hacia adelante", () => {
    expect(inicioEnRango(new Date(desplazada(-HORAS_ATRAS).getTime() - 60_000), ahora)).toBe(false);
    expect(inicioEnRango(new Date(desplazada(HORAS_ADELANTE).getTime() + 60_000), ahora)).toBe(false);
  });

  it("rechaza anotar atenciones de hace semanas: eso lo hace recepción", () => {
    expect(inicioEnRango(desplazada(-24 * 30), ahora)).toBe(false);
  });

  it("rechaza una fecha inválida en vez de tratarla como 'ahora'", () => {
    expect(inicioEnRango(new Date("no es una fecha"), ahora)).toBe(false);
  });
});

describe("serviciosNoPermitidos — solo lo que ella hace", () => {
  const suyos = new Set(["manicure-clasica", "uñas-builder"]);

  it("no marca nada cuando todos son suyos", () => {
    expect(serviciosNoPermitidos(["manicure-clasica"], suyos)).toEqual([]);
    expect(serviciosNoPermitidos(["manicure-clasica", "uñas-builder"], suyos)).toEqual([]);
  });

  it("devuelve los que no hace, sin perder el orden", () => {
    expect(serviciosNoPermitidos(["manicure-clasica", "keratina", "balayage"], suyos)).toEqual([
      "keratina",
      "balayage",
    ]);
  });

  it("si no hace ninguno de la lista, devuelve toda la lista", () => {
    expect(serviciosNoPermitidos(["keratina"], suyos)).toEqual(["keratina"]);
  });

  it("una profesional sin servicios asignados no puede anotar ninguno", () => {
    expect(serviciosNoPermitidos(["manicure-clasica"], new Set())).toEqual(["manicure-clasica"]);
  });
});

describe("estadoSchema — marcar una cita", () => {
  it.each(["confirmada", "cancelada", "completada", "no_asistio"])("acepta %s", (estado) => {
    expect(estadoSchema.safeParse({ estado }).success).toBe(true);
  });

  it.each(["", "pendiente", "COMPLETADA", "borrada", "no vino"])("rechaza %j", (estado) => {
    expect(estadoSchema.safeParse({ estado }).success).toBe(false);
  });

  it("rechaza un cuerpo sin estado", () => {
    expect(estadoSchema.safeParse({}).success).toBe(false);
  });
});

describe("atencionSchema — atención sin reserva", () => {
  const base = {
    servicio_ids: ["manicure-clasica"],
    sede_id: "los-olivos",
    inicio: "2026-09-26T10:00:00-05:00",
  };

  it("acepta una clienta que ya es suya", () => {
    expect(atencionSchema.safeParse({ ...base, cliente_id: CLIENTA }).success).toBe(true);
  });

  it("acepta una clienta nueva con teléfono y nombre", () => {
    expect(atencionSchema.safeParse({ ...base, telefono: "987 654 321", nombre: "Rosa Quispe" }).success).toBe(true);
  });

  it("rechaza una nueva sin nombre: crearía una clienta sin identificar", () => {
    expect(atencionSchema.safeParse({ ...base, telefono: "987654321" }).success).toBe(false);
  });

  it("rechaza sin ninguna clienta", () => {
    expect(atencionSchema.safeParse(base).success).toBe(false);
  });

  it("estado por defecto: ya se atendió", () => {
    const r = atencionSchema.safeParse({ ...base, cliente_id: CLIENTA });
    expect(r.success && r.data.estado).toBe("completada");
  });

  it("no admite estados que no sean confirmada o completada", () => {
    expect(atencionSchema.safeParse({ ...base, cliente_id: CLIENTA, estado: "cancelada" }).success).toBe(false);
  });

  it("no acepta profesional_id: siempre es ella, y el cuerpo no puede decir otra cosa", () => {
    // zod ignora las claves de más en vez de rechazarlas, así que lo que hay
    // que garantizar es que NO llegue al resultado y la ruta nunca lo lea.
    const r = atencionSchema.safeParse({ ...base, cliente_id: CLIENTA, profesional_id: OTRA });
    expect(r.success).toBe(true);
    expect(r.success && "profesional_id" in r.data).toBe(false);
  });

  it("rechaza una fecha sin zona horaria", () => {
    expect(atencionSchema.safeParse({ ...base, cliente_id: CLIENTA, inicio: "2026-09-26T10:00:00" }).success).toBe(false);
  });

  it("limita a 10 servicios y exige al menos uno", () => {
    expect(atencionSchema.safeParse({ ...base, cliente_id: CLIENTA, servicio_ids: [] }).success).toBe(false);
    const once = Array.from({ length: 11 }, (_, i) => `s${i}`);
    expect(atencionSchema.safeParse({ ...base, cliente_id: CLIENTA, servicio_ids: once }).success).toBe(false);
  });
});

describe("ventaSchema — venta de un producto", () => {
  const base = { sede_id: "los-olivos", concepto: "Champú sin sal", monto: 45 };

  it("acepta una venta normal, en efectivo por defecto", () => {
    const r = ventaSchema.safeParse(base);
    expect(r.success && r.data.metodo).toBe("efectivo");
  });

  it.each(["efectivo", "yape", "plin", "tarjeta", "transferencia", "otro"])("acepta el método %s", (metodo) => {
    expect(ventaSchema.safeParse({ ...base, metodo }).success).toBe(true);
  });

  it("rechaza un método que no existe en el enum de la base", () => {
    expect(ventaSchema.safeParse({ ...base, metodo: "bitcoin" }).success).toBe(false);
  });

  it("acepta justo el tope y rechaza un sol más", () => {
    expect(ventaSchema.safeParse({ ...base, monto: MAX_VENTA_SOLES }).success).toBe(true);
    expect(ventaSchema.safeParse({ ...base, monto: MAX_VENTA_SOLES + 1 }).success).toBe(false);
  });

  it("rechaza montos en cero, negativos o que no son número", () => {
    expect(ventaSchema.safeParse({ ...base, monto: 0 }).success).toBe(false);
    expect(ventaSchema.safeParse({ ...base, monto: -10 }).success).toBe(false);
    expect(ventaSchema.safeParse({ ...base, monto: "45" }).success).toBe(false);
  });

  it("rechaza un concepto vacío", () => {
    expect(ventaSchema.safeParse({ ...base, concepto: "  " }).success).toBe(false);
  });

  it("no acepta cambiar el tipo ni la categoría: siempre ingreso de producto", () => {
    const r = ventaSchema.safeParse({ ...base, tipo: "egreso", categoria: "sueldo" });
    expect(r.success).toBe(true);
    expect(r.success && ("tipo" in r.data || "categoria" in r.data)).toBe(false);
  });
});
