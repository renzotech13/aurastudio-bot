# Encender WhatsApp en el bot de Aura

El bot ya está desplegado y sano en `bot.aurastudio.pe`. Todo lo demás está
configurado en Railway (Supabase, Anthropic, Google Calendar, dominios). Para
activar el canal de WhatsApp **faltan exactamente cuatro variables**.

El código está preparado para esto: `src/config/env.ts` las declara opcionales
a propósito, así que el servicio arranca sin ellas y la reserva por web
funciona igual. En cuanto estén cargadas y el servicio reinicie, el canal se
enciende **sin volver a desplegar**.

## Las cuatro variables

| Variable | De dónde sale en Meta |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → *Phone number ID* del número de Aura. Es un número largo, no el teléfono. |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp → API Setup. El temporal dura 24 h: hay que generar uno **permanente** desde un System User en Business Settings, o el bot se cae al día siguiente. |
| `WHATSAPP_APP_SECRET` | App Settings → Basic → *App secret*. Con esto se valida la firma de cada webhook entrante; sin él, cualquiera podría publicar mensajes falsos. |
| `WHATSAPP_VERIFY_TOKEN` | **Te lo inventas tú.** Una cadena larga al azar. Va en Railway y, la misma, en el campo *Verify token* de Meta. |

No reutilizar el número ni el `phone_number_id` de otro negocio: un mismo
número no puede servir a dos cuentas de WhatsApp Business API.

## Cargarlas

Desde `bot/`, una por una (así no quedan en el historial del shell si usas un
espacio delante del comando):

```bash
railway variables --set WHATSAPP_PHONE_NUMBER_ID=...
```

O más seguro: Railway → proyecto `aurastudio-bot` → servicio → **Variables** →
*New Variable*. Al guardar, Railway reinicia el servicio solo.

## El webhook en Meta

- **Callback URL**: `https://bot.aurastudio.pe/webhook`
- **Verify token**: el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`
- **Campos a suscribir**: `messages`

Meta hace un `GET /webhook` con el token para verificar. Si responde 403,
es que el token de Railway y el de Meta no coinciden, o que el servicio aún
no reinició con la variable nueva.

## Comprobar que quedó

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://bot.aurastudio.pe/health
railway logs
```

Y mandar un WhatsApp al número desde otro teléfono: en los logs tiene que
aparecer el mensaje entrante.

## Antes de darlo a las clientas

Tres cosas que hoy el bot **no** sabe, y que conviene resolver antes de
publicar el número:

1. **Solo nombra una sede.** `ADDRESS` en `src/agent/systemPrompt.ts` tiene la
   dirección de Los Olivos. A una clienta de Independencia le va a dar la
   dirección equivocada.
2. **No pregunta por estilista.** No hay concepto de profesional en el bot, así
   que agenda sin decidir quién atiende.
3. **La agenda admite una sola cita simultánea en todo el negocio.** El
   `EXCLUDE` de `citas` es global (ver el plan de mejoras). Con el bot
   encendido, la segunda clienta que intente reservar a la misma hora —aunque
   sea en el otro local— recibe "ese horario ya no está disponible".

El punto 3 es el que más duele: no es un texto mal puesto, es que el negocio
va a rechazar reservas reales. Se arregla en la migración de sedes y
profesionales.

## Plantillas de Meta

`WHATSAPP_TEMPLATE_RECORDATORIO` ya está en Railway, pero la plantilla tiene
que estar **aprobada por Meta** para que el recordatorio salga. Fuera de la
ventana de 24 h no se puede mandar texto libre: a una clienta que reservó por
web y nunca escribió por WhatsApp solo se le puede llegar por plantilla.
