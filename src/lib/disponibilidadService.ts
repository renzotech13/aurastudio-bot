import { getBusinessHours } from "../db/repositories/businessHours.js";
import { getBloqueosEnRango } from "../db/repositories/bloqueos.js";
import { supabase } from "../db/client.js";
import { citasQueOcupanA, getAvailableSlots, getLocalWeekdayAndTime, isSlotAvailable, timeStringToUtcDate } from "./availability.js";
import { BUFFER_MINUTES, MIN_LEAD_MINUTES, SLOT_STEP_MINUTES, BUSINESS_TIMEZONE } from "../config/business.js";

const MAX_DIAS = 14;

function addDays(fechaLocal: string, days: number): string {
  const d = new Date(`${fechaLocal}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Horarios realmente libres para un bloque de `duracionMinutos` (la tool del
 * agente y el endpoint público de reserva.html llaman a esto — antes vivía
 * duplicado dentro de la tool; ahora es la única fuente de verdad para "qué
 * hueco existe de verdad").
 */
export async function consultarDisponibilidadReal(params: {
  duracionMinutos: number;
  fechaDesde: string;
  fechaHasta: string;
  /**
   * Profesionales candidatas. Una sola cuando la clienta eligió a alguien;
   * varias cuando eligió "cualquier profesional" (entonces una hora está
   * libre si la puede tomar AL MENOS UNA de ellas, y se decide cuál recién
   * al reservar). Vacío o ausente = agenda del local entera, que es como se
   * comportaba antes de la migración 0014 y es lo que sigue usando el bot
   * de WhatsApp mientras no pregunte por sede.
   */
  profesionalIds?: string[];
}): Promise<{ fecha: string; horas: string[] }[]> {
  const fechaHasta = params.fechaHasta < params.fechaDesde ? params.fechaDesde : params.fechaHasta;
  const dias: string[] = [];
  for (let f = params.fechaDesde; f <= fechaHasta && dias.length < MAX_DIAS; f = addDays(f, 1)) {
    dias.push(f);
  }

  const businessHours = await getBusinessHours();
  const desdeUtc = timeStringToUtcDate(params.fechaDesde, "00:00", BUSINESS_TIMEZONE);
  const hastaUtc = timeStringToUtcDate(addDays(fechaHasta, 1), "00:00", BUSINESS_TIMEZONE);
  const [bloqueos, citasRows] = await Promise.all([
    getBloqueosEnRango(desdeUtc, hastaUtc),
    supabase
      .from("citas")
      .select("inicio_utc,fin_utc,profesional_id")
      .neq("estado", "cancelada")
      .lt("inicio_utc", hastaUtc.toISOString())
      .gt("fin_utc", desdeUtc.toISOString())
      .then(({ data, error }) => {
        if (error) throw error;
        return (data ?? []).map((r) => ({
          inicioUtc: new Date(r.inicio_utc as string),
          finUtc: new Date(r.fin_utc as string),
          profesionalId: (r.profesional_id as string | null) ?? null,
        }));
      }),
  ]);

  const now = new Date();
  // Sin candidatas, una sola pasada contra la agenda del local (comportamiento
  // anterior a la 0014). Con candidatas, una pasada por persona: cada una ve
  // sólo lo que a ella la ocupa.
  const agendas: (string | null)[] = params.profesionalIds?.length ? params.profesionalIds : [null];

  return dias.map((fechaLocal) => {
    const horas = new Set<string>();
    for (const profesionalId of agendas) {
      const slots = getAvailableSlots({
        fechaLocal,
        durationMinutes: params.duracionMinutos,
        timezone: BUSINESS_TIMEZONE,
        businessHours,
        bloqueos,
        existingCitas: citasQueOcupanA(citasRows, profesionalId),
        bufferMinutes: BUFFER_MINUTES,
        minLeadMinutes: MIN_LEAD_MINUTES,
        stepMinutes: SLOT_STEP_MINUTES,
        now,
      });
      for (const s of slots) horas.add(getLocalWeekdayAndTime(s.inicioUtc, BUSINESS_TIMEZONE).time);
    }
    // La unión sale desordenada del Set; "HH:MM" ordena bien como texto.
    return { fecha: fechaLocal, horas: [...horas].sort() };
  });
}

/**
 * Cuál de las candidatas puede tomar realmente este horario. Es lo que
 * convierte "cualquier profesional" en una persona concreta al reservar —
 * la cita nunca se guarda sin profesional (ver migración 0014).
 */
export async function elegirProfesionalLibre(params: {
  profesionalIds: string[];
  inicioUtc: Date;
  finUtc: Date;
}): Promise<string | null> {
  const desde = new Date(params.inicioUtc.getTime() - 24 * 60 * 60_000);
  const hasta = new Date(params.finUtc.getTime() + 24 * 60 * 60_000);
  const [businessHours, bloqueos, citas] = await Promise.all([
    getBusinessHours(),
    getBloqueosEnRango(desde, hasta),
    supabase
      .from("citas")
      .select("inicio_utc,fin_utc,profesional_id")
      .neq("estado", "cancelada")
      .lt("inicio_utc", hasta.toISOString())
      .gt("fin_utc", desde.toISOString())
      .then(({ data, error }) => {
        if (error) throw error;
        return (data ?? []).map((r) => ({
          inicioUtc: new Date(r.inicio_utc as string),
          finUtc: new Date(r.fin_utc as string),
          profesionalId: (r.profesional_id as string | null) ?? null,
        }));
      }),
  ]);

  const now = new Date();
  for (const profesionalId of params.profesionalIds) {
    const check = isSlotAvailable({
      inicioUtc: params.inicioUtc,
      finUtc: params.finUtc,
      timezone: BUSINESS_TIMEZONE,
      businessHours,
      bloqueos,
      existingCitas: citasQueOcupanA(citas, profesionalId),
      bufferMinutes: BUFFER_MINUTES,
      minLeadMinutes: MIN_LEAD_MINUTES,
      now,
    });
    if (check.available) return profesionalId;
  }
  return null;
}
