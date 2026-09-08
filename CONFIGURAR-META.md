# Encender Messenger, Instagram y comentarios en el bot de Aura

El bot ya soporta los tres canales (`meta/`, `routes/metaWebhook.ts`,
`canales/`) y arranca igual sin ninguna de estas variables — mientras no
estén, esos canales quedan apagados y WhatsApp sigue funcionando normal.
Esta guía es para encenderlos, en el mismo espíritu que
`CONFIGURAR-WHATSAPP.md`.

## 1. La app de Meta

Usar **la misma app** que ya tiene WhatsApp — un solo `APP_SECRET` y un solo
System User es más simple de mantener que dos apps separadas. Desde
developers.facebook.com, agregar los productos **Messenger** e **Instagram**
a esa app.

También hace falta cargar, en la configuración básica de la app:
- **URL de política de privacidad**: `https://aurastudio.pe/privacidad.html`
- **URL de instrucciones de eliminación de datos** (obligatoria para pasar
  a modo Live)

## 2. Página e Instagram vinculados

- La cuenta de Instagram tiene que ser **profesional** (empresa o creador),
  no personal.
- Tiene que estar **vinculada a la página de Facebook** de Aura Studio
  (Meta Business Suite → Configuración → Cuentas vinculadas).
- En la propia app de Instagram: **Configuración → Mensajes y respuestas a
  historias → Controles de mensajes → Herramientas conectadas → Permitir
  acceso a mensajes**. Sin esto, la API no puede leer ni mandar DMs aunque
  todo el resto esté bien.

## 3. El token

Se usa **un System User** (rol Admin) en Business Manager, con la app y los
activos (la página + la cuenta de Instagram) asignados — igual patrón que
recomendamos para WhatsApp, para no depender de la cuenta personal de nadie.

Generar un token **sin expiración** con estos permisos:

| Permiso | Para qué |
|---|---|
| `pages_messaging` | Enviar y recibir DMs de Messenger |
| `pages_manage_metadata` | Suscribir la página a los webhooks |
| `pages_read_engagement` | Leer comentarios y metadatos de publicaciones |
| `pages_manage_engagement` | Responder comentarios en público |
| `pages_read_user_content` | Leer contenido de usuarios en la página |
| `pages_show_list` | Listar las páginas del negocio |
| `instagram_basic` | Leer datos básicos de la cuenta de Instagram |
| `instagram_manage_messages` | Enviar y recibir DMs de Instagram |
| `instagram_manage_comments` | Responder comentarios de Instagram |
| `business_management` | Administrar los activos del Business Manager |
| `read_insights` | Métricas de la página (alcance, interacciones) |
| `instagram_manage_insights` | Métricas de la cuenta de Instagram |

Con ese token, pedir `GET /me/accounts` para obtener el **Page Access
Token** de la página de Aura Studio — es ese, no el del System User
directamente, el que va en `META_PAGE_ACCESS_TOKEN`.

## 4. Las variables

| Variable | De dónde sale |
|---|---|
| `META_PAGE_ID` | El id de la página de Facebook de Aura Studio. |
| `META_PAGE_ACCESS_TOKEN` | El Page Access Token del paso 3. |
| `META_IG_ACCOUNT_ID` | Id de la cuenta de Instagram — sale de `GET /{PAGE_ID}?fields=instagram_business_account`. |
| `META_APP_SECRET` | Si Messenger/Instagram viven en la misma app que WhatsApp (lo normal), **dejar vacía**: el bot cae solo a `WHATSAPP_APP_SECRET`. |
| `META_VERIFY_TOKEN` | Ídem: vacía si es la misma app, cae a `WHATSAPP_VERIFY_TOKEN`. |
| `META_HUMAN_AGENT_APROBADO` | `true` solo si Meta aprobó la función Human Agent en App Review (paso 6). Mientras diga `false`, nadie —ni el bot ni el staff— puede escribir por Messenger/Instagram pasadas las 24h desde el último mensaje de la clienta. |

Cargar en Railway y reiniciar — el servicio detecta las variables nuevas
solo, sin volver a desplegar código.

## 5. Los webhooks

- **Callback URL**: `https://bot.aurastudio.pe/webhook/meta`
- **Verify token**: el mismo valor que `META_VERIFY_TOKEN` (o
  `WHATSAPP_VERIFY_TOKEN` si se dejó vacío)
- **Objeto Page**, campos a suscribir: `messages`, `messaging_postbacks`,
  `message_echoes`, `feed`
- **Objeto Instagram**, campos: `messages`, `comments`,
  `messaging_postbacks`

Después de suscribir en el dashboard, suscribir la página a la app por API:

```bash
curl -X POST "https://graph.facebook.com/v26.0/{PAGE_ID}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes,feed&access_token={PAGE_ACCESS_TOKEN}"
```

Comprobar con:

```bash
curl "https://graph.facebook.com/v26.0/{PAGE_ID}/subscribed_apps?access_token={PAGE_ACCESS_TOKEN}"
```

## 6. Protocolo de handover

En **Meta Business Suite → Configuración → Mensajería avanzada**, poner
esta app como **receptor principal** de la página. Si no, los mensajes
pueden quedarse solo en la bandeja de Meta Business Suite y nunca llegarle
al webhook del bot — es la causa más común de "no me está llegando nada"
cuando todo lo demás está bien configurado. Revisar si Instagram tiene un
control equivalente en su propia configuración de mensajería.

## 7. App Review y verificación de negocio

En modo desarrollo, la app **solo puede recibir mensajes de personas con un
rol asignado en ella** (admin, developer, tester) — sirve para probar, no
para atender clientas reales.

Para eso hace falta:
- **Verificación de negocio** (Business Verification) del Business Manager.
- **Acceso avanzado** (Advanced Access) a `pages_messaging`,
  `instagram_manage_messages`, `instagram_manage_comments`,
  `pages_manage_engagement` — se pide en App Review, con video/capturas que
  muestren el flujo real (una clienta escribe → el bot responde → puede
  escalar a una persona).
- Si se quiere responder pasadas las 24h por estos canales, pedir también
  la función **Human Agent** en el mismo review, explicando que se usa solo
  cuando una persona del staff retoma la conversación (nunca para mensajes
  automáticos — ver política abajo).

Mientras la verificación esté "en revisión", todo lo de arriba funciona
igual para las cuentas de prueba — es el momento de hacer la prueba de
punta a punta del paso 8 antes de anunciar el canal.

## 8. Prueba de punta a punta

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://bot.aurastudio.pe/health
railway logs
```

Y con una cuenta que tenga rol en la app: mandar un DM a la página de
Facebook (o a la cuenta de Instagram) → tiene que aparecer en
**Conversaciones** del panel → responder desde ahí → tiene que llegarle a
esa cuenta por Messenger/Instagram. Repetir comentando en una publicación
para probar el flujo de comentarios (`origen='comentario'` en el panel, con
los botones de responder en público/privado).

## 9. Política de Meta a respetar

- La experiencia automatizada tiene que poder derivar a una persona —ya lo
  hace la tool `escalar_a_humano`—, no puede ser un bot cerrado sin salida.
- El tag **Human Agent** es solo para cuando una persona real está
  respondiendo, nunca para mensajes automáticos del bot.
- A diferencia de WhatsApp (que tiene plantillas de categoría Marketing),
  Messenger e Instagram **no permiten mandar promociones fuera de la
  ventana de 24h** — `PromoDialog` en el panel sigue siendo solo para
  clientas con teléfono de WhatsApp, a propósito.

## Sobre las métricas de contenido

`meta/insights.ts` guarda una foto diaria de alcance/interacciones/
seguidores en `metricas_contenido_diarias` (se ve en **Métricas → 
Contenido** del panel). La Insights API de Meta está cambiando bastante los
nombres de sus métricas por estos meses — si el barrido empieza a loguear
"Insights rechazados por Meta", revisar el comentario al principio de
`meta/insights.ts` y ajustar `METRICAS_FACEBOOK`/`METRICAS_INSTAGRAM` contra
la referencia oficial vigente en ese momento.
