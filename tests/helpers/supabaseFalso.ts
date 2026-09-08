/**
 * Doble del query builder de supabase-js.
 *
 * Encadena igual que el real y anota los filtros aplicados, que es lo que
 * interesa afirmar en los repositorios: casi siempre el bug no está en que
 * la consulta falle, sino en que mira la columna equivocada (o se olvida de
 * una) y devuelve la fila que no era.
 */
export type Filtro = { op: string; args: unknown[] };

export type SupabaseFalso = {
  supabase: { from: (tabla: string) => unknown };
  /** Filas que devuelve cada consulta, en orden; se van consumiendo. */
  busqueda: unknown[];
  /** Resultado de la inserción: { data } o { error: { code } }. */
  insercion: { data?: unknown; error?: unknown } | null;
  filtros: Filtro[];
  tablas: string[];
  insertado: Record<string, unknown> | null;
  reiniciar: () => void;
  filtro: (op: string, campo: string) => Filtro | undefined;
};

const OPS_ENCADENABLES = ["select", "eq", "neq", "in", "is", "gte", "lte", "order", "limit", "insert", "update"];

export function crearSupabaseFalso(): SupabaseFalso {
  const estado: SupabaseFalso = {
    supabase: { from: (tabla: string) => nuevoBuilder(tabla) },
    busqueda: [],
    insercion: null,
    filtros: [],
    tablas: [],
    insertado: null,
    reiniciar() {
      estado.busqueda = [];
      estado.insercion = null;
      estado.filtros = [];
      estado.tablas = [];
      estado.insertado = null;
    },
    filtro(op, campo) {
      return estado.filtros.find((f) => f.op === op && f.args[0] === campo);
    },
  };

  function nuevoBuilder(tabla: string) {
    estado.tablas.push(tabla);
    let escribiendo = false;
    const builder: Record<string, unknown> = {};

    for (const op of OPS_ENCADENABLES) {
      builder[op] = (...args: unknown[]) => {
        if (op === "insert" || op === "update") {
          escribiendo = true;
          estado.insertado = args[0] as Record<string, unknown>;
        } else if (!escribiendo) {
          // Los filtros posteriores a un insert son del .select() de vuelta,
          // no de la búsqueda: anotarlos confundiría las afirmaciones.
          estado.filtros.push({ op, args });
        }
        return builder;
      };
    }

    builder.maybeSingle = () => Promise.resolve({ data: estado.busqueda.shift() ?? null, error: null });
    builder.single = () => Promise.resolve(estado.insercion ?? { data: null, error: null });
    return builder;
  }

  return estado;
}
