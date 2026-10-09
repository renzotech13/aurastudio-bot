# Reactivación de clientas ya atendidas

El bot le escribe por WhatsApp a quien ya se atendió y no volvió, invitándola con
una oferta. Cuánto tiempo espera y qué ofrece depende del servicio que se hizo.
Todo se decide desde la app (**Más → Reactivación**) y **nace apagado**.

Requiere las migraciones `0021` y `0022` (se pegan a mano en el SQL editor de
Supabase, en ese orden) y que Meta haya aprobado las dos plantillas de abajo.

## Cómo funciona

1. Cada 20 minutos, de 10:00 a 20:00 (hora de Lima), el bot pregunta a la base
   «¿a quién le toca?» (`reactivacion_candidatas`).
2. Le toca a una clienta si su **última atención terminada** (cita «completada»)
   fue hace entre *N* y *N + 5* días según una regla activa, y además:
   - **no volvió** ni tiene una cita confirmada por venir,
   - tiene teléfono y no está marcada «no contactar»,
   - no recibió otra reactivación en los últimos 10 días,
   - no se le mandó ya esa misma regla por esa misma atención.
3. Se **reserva** la fila en `reactivaciones` (el índice único impide que dos
   vueltas manden lo mismo) y se envía:
   - si ella escribió en las últimas 24 h: **texto libre** (gratis, sin plantilla),
   - si no: la **plantilla** de la regla con sus 4 variables.
4. Lo enviado queda **también en su chat**, para que el equipo y el bot sepan qué
   se le ofreció si ella responde.
5. Si pasa de *N + 5* días sin que le tocara (apagado, horario, tope), esa regla
   ya no se le manda: no se avisa «hace 15 días» a quien se atendió hace 40.

> Depende de que las atenciones se marquen **«Atendida»** (profesionales desde su
> app, o recepción). Una cita que queda «confirmada» para siempre no cuenta como
> atención y esa clienta nunca recibirá nada.

## Las reglas de partida (todas apagadas)

Son un punto de partida para afinar con el uso, no una verdad.

| Regla | Servicio | Días | Plantilla | Oferta | Código |
|---|---|---|---|---|---|
| Uñas | manicure | 15 | `vuelve_aura` | 10 % en tu próxima manicure | UNAS10 |
| Pestañas | pestañas | 15 | `vuelve_aura` | 10 % en tu retoque | PESTA10 |
| Cejas | cejas | 15 | `vuelve_aura` | 10 % en tu retoque de cejas | CEJAS10 |
| Cabello | cabello | 15 | `vuelve_aura` | 10 % en tu próximo tratamiento | PELO10 |
| Pedicura | pies | 21 | `vuelve_aura` | 10 % en tu próxima pedicura | PIES10 |
| Color | color | 30 | `vuelve_aura` | 10 % en tu retoque de color | COLOR10 |
| Te extrañamos · al mes | cualquiera | 30 | `te_extranamos_aura` | 15 % en cualquier servicio | VUELVE15 |
| Te extrañamos · 2 meses | cualquiera | 60 | `te_extranamos_aura` | 20 % en cualquier servicio | VUELVE20 |

Si a una clienta le tocan dos reglas a la vez (p. ej. color al mes y «te
extrañamos» al mes), recibe solo la de su servicio.

**El descuento no se aplica solo.** Va en el mensaje con un código; ella lo dice
al reservar y se descuenta al cobrar. El bot hoy no maneja precios.

## Paso a paso para encenderlo

1. **Migraciones:** pegar `0021_rol_vendedor_y_leads.sql` y `0022_reactivacion.sql`
   en el SQL editor de Supabase (idempotentes; se pueden volver a correr).
2. **Crear las 2 plantillas en Meta** (Administrador de WhatsApp → Plantillas de
   mensajes). Categoría **Marketing**, idioma **Español (`es`)**, con **exactamente**
   estos textos (los nombres tienen que coincidir):

   **`vuelve_aura`**
   ```
   Hola {{1}} 💛 Gracias por visitarnos en Aura Studio ({{2}}). Para tu próxima cita tienes {{3}} con el código {{4}}. Si quieres separar tu espacio, respóndenos por aquí y te ayudamos.
   ```
   Ejemplos para Meta: `Lucía`, `Esmaltado en gel`, `10 % de descuento en tu próxima manicure`, `UNAS10`.

   **`te_extranamos_aura`**
   ```
   Hola {{1}} 💛 Te extrañamos en Aura Studio. Pasó un tiempo desde tu última visita ({{2}}) y queremos verte de vuelta: {{3}} con el código {{4}} en tu próxima cita. Respóndenos por aquí y te reservamos tu espacio.
   ```
   Ejemplos para Meta: `Lucía`, `Baby boomer`, `15 % de descuento en cualquier servicio`, `VUELVE15`.

3. **Esperar la aprobación** (minutos a unas horas).
4. **Probar**: en la app, *Más → Reactivación → (una regla) → «Enviar una prueba a mi
   número»*. Manda la plantilla con datos de ejemplo. Si Meta responde que no salió,
   la plantilla no está aprobada o el nombre no coincide.
5. **Prender las reglas** que quieras y revisar «Se le escribiría en la próxima
   vuelta»: ahí se ve a quién le tocaría, sin enviar nada. Quien no deba recibirlo:
   «No contactar».
6. **Prender el envío automático** (pide confirmación).

## Cómo se mide

En la misma pantalla, últimos 30 días: **Enviadas**, **Volvieron** (agendó una
cita después del mensaje, dentro de 45 días) y **No salieron** (con el motivo).
Con eso se afinan los días y las ofertas: si una regla no trae a nadie de vuelta,
se cambia el plazo o la oferta, no se agregan más mensajes.

## Si Aura cambia de cuenta de WhatsApp o de app en Meta

Las plantillas pertenecen a la **cuenta de WhatsApp (WABA)**, no al bot: al mover
el número a una cuenta nueva hay que **volver a crear y esperar la aprobación**
de estas dos. Mientras tanto, apagar el envío automático.

## Cuidados

- No subir el tope por vuelta ni acortar la separación entre mensajes sin mirar la
  calidad del número en Meta: muchos bloqueos o reportes lo degradan.
- Quien pida que no le escriban: «No contactar» en su ficha (Más → Clientas).
- Las plantillas de **Utilidad** (como `recordatorio_cita`) son solo para avisos de
  una cita concreta; usarlas para promocionar viola la política de Meta.
