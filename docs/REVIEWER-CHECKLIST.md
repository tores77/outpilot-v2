# Checklist del revisor — OUTPILOT v2

Este documento convierte en reglas el criterio de revisión aplicado en cada gate de las Fases 0 y 1. Antes de parar en un gate, Claude Code se autorrevisa con esta lista y corrige lo que falle **antes** de reportar. Pere verifica lo que necesita ojos humanos y da el OK.

La spec (`docs/OUTPILOT_v2_Spec_INTERNA.md`) sigue siendo el contrato. Si este checklist y la spec chocan, manda la spec, y el choque se reporta.

---

## 1. Siempre requiere OK explícito de Pere

Parar y preguntar, sin excepción, cuando la tarea:

- **Gasta dinero real:** créditos de Vibe, envíos reales por Lemlist, cualquier API de pago con coste por llamada. El primer body válido de una API de pago se enseña, no se envía.
- **Es irreversible o destructiva:** borrar datos, `DROP`, reescribir historia de git, revocar o rotar credenciales.
- **Toca datos o schema de producción:** las migraciones las escribe Claude Code y las aplica Pere con psql.
- **Contradice la spec** o toma una decisión estructural que la spec no dicta (columnas, enums, taxonomías, umbrales, prompts): proponer y esperar.
- **Añade una dependencia nueva**, un servicio externo o una variable de entorno nueva.
- **Cambia la autonomía de un agente** (SUGERIR → ACT) o cualquier cosa que actúe sin revisión humana.

---

## 2. Checklist por tarea

Marcar solo lo que aplica. En el reporte del gate, incluir los puntos relevantes con su estado.

### Contrato y scope
- [ ] Lo construido corresponde a la tarea de la spec, sin adelantar trabajo de tareas futuras.
- [ ] Sin diseño especulativo: solo los métodos, columnas y opciones que alguna tarea necesita ya.
- [ ] Si la spec no dictaba un detalle, se preguntó en vez de inventarlo.
- [ ] La spec sigue coherente con el código. Menciones huérfanas corregidas y marcadas como aclaración R2.
- [ ] Ideas y mejoras fuera de scope anotadas en `BACKLOG.md`, no implementadas.

### Datos y seguridad
- [ ] Toda tabla nueva lleva `tenant_id` y RLS con `public.current_user_tenant_id()`.
- [ ] Test de aislamiento preparado para Pere: JWT allowlisted ve sus filas, intruso ve 0 sin error.
- [ ] Queries en `/jobs/**` filtran por `tenant_id` (la regla de lint lo exige; no desactivarla).
- [ ] El cliente `service` y el wrapper de IA solo se importan desde jobs.
- [ ] Ningún secreto en código, logs, errores ni en `.env.example`. Las keys se redactan en cualquier salida.
- [ ] Migraciones nuevas y versionadas; nunca se edita una migración ya aplicada.

### Integraciones externas
- [ ] Contrato verificado contra la API real antes de construir el cliente: probes, doc oficial.
- [ ] Probes gratis primero (errores de validación 422, endpoints de stats); los de pago, con gate.
- [ ] Field names, enums y shapes tomados de respuestas reales, nunca supuestos.
- [ ] Timeouts, reintentos con backoff en 5xx/429 y fail-fast en otros 4xx.
- [ ] Los probes se conservan en `scripts/` como registro del contrato.
- [ ] Exploración inline hacia campos de contenido: truncado desde la primera ejecución, nunca como refinado posterior.

### Dinero y costes
- [ ] APIs de pago siguen el patrón estimate (gratis) → confirmación con token → execute.
- [ ] Doble candado: límite de volumen + tope de coste en config.
- [ ] Cada llamada con coste queda en `api_costs` (Claude en USD, Vibe en créditos; distinguir por `model`).
- [ ] Coste estimado vs real comparado tras la primera ejecución real; heurística recalibrada si difiere.
- [ ] Pasos baratos antes que caros: limpiar y deduplicar antes de enriquecer o enviar.

### Idempotencia y fiabilidad
- [ ] Cada evento externo lleva su id de proveedor como campo explícito, con unique parcial en BD.
- [ ] Operaciones repetibles (upsert, addLead, webhooks) no duplican si se ejecutan dos veces.
- [ ] Los pasos de Inngest usan `step.run` y devuelven primitivos serializables.
- [ ] Webhooks verifican autenticidad (firma o secret) en la ruta, antes de parsear.
- [ ] Fechas de ventanas de envío construidas con `Europe/Madrid` explícito, nunca UTC implícito.

### IA y prompts
- [ ] Reglas anti-fabricación al principio del prompt: usar solo campos presentes; ausencia no es señal negativa ni positiva.
- [ ] La salida del modelo cita qué campos usó.
- [ ] Sin datos suficientes → resultado bajo y marcado (o plantilla genérica marcada), nunca inventado.
- [ ] Cualquier umbral que promueva un estado exige al menos una señal verificable.
- [ ] Routing de modelos según `config/models.ts` (Haiku volumen, Sonnet calidad).
- [ ] Parser tolerante a respuestas malformadas; una entrada rota no tumba el lote.

### Estado de los leads
- [ ] Las transiciones de estado solo avanzan; nada degrada un lead ya en secuencia o con respuesta.
- [ ] La lógica de transición vive en una función pura y testeable.

### Tests y CI
- [ ] Lógica nueva cubierta con tests deterministas, sin llamadas a APIs reales.
- [ ] Fixtures derivados de respuestas reales, anonimizados.
- [ ] `npm test`, `tsc --noEmit`, `lint` y `build` en verde en local antes del push.
- [ ] CI en verde tras el push, incluido el drift check de tipos.

### Deploy y entorno
- [ ] Variables de entorno nuevas documentadas en `.env.example` y añadidas en Vercel (con redeploy: Vercel no aplica vars nuevas a deploys ya construidos).
- [ ] Funciones nuevas de Inngest: pedir a Pere que confirme que aparecen sin Resync manual.
- [ ] Tras un deploy con funciones Inngest nuevas, confirmar sync y versión de SDK en el panel.
- [ ] Si un deploy no sincroniza, mirar Inngest → Apps → Unattached Syncs: ahí aparecen los intentos fallidos con la URL y el error. Vercel Deployment Protection bloquea integraciones que llaman a la URL única del deploy.
- [ ] Versión de la CLI de Supabase igual en local y en CI; si cambia, subirla en ambos y regenerar tipos en el mismo commit.
- [ ] Tokens y credenciales nuevos, sin caducidad o con la caducidad anotada.

### Historia
- [ ] Un commit por tarea; fixes como commits propios con su razón. Sin amend de commits ya pusheados.
- [ ] Mensajes de commit que cuentan lo que pasó, incluidos los errores.

---

## 3. Formato del reporte de gate

1. **Qué hice**, en pocas líneas.
2. **Archivos tocados.**
3. **Checklist:** solo los puntos que aplican, con ✅ / ⚠️ y una línea de explicación en los ⚠️.
4. **Cómo lo verifica Pere:** pasos exactos (comandos, URLs, SQL), marcando cuáles gastan dinero.
5. **Decisiones que necesito de ti**, numeradas, con mi recomendación en cada una.

---

## 4. Lecciones aprendidas (por qué existe cada regla)

- **Recursión RLS (T004):** una policy que consulta su propia tabla entra en bucle. Solución: helper `security definer`. Lección: probar RLS con JWT simulado antes de dar por buena la auth.
- **Vibe devuelve email hasheado (T014):** el fetch no trae emails en claro; hace falta un enrich aparte y de pago. Sin el probe, el mapper habría guardado cero leads.
- **Coste real el doble del estimado (T014):** los probes aislados decían 3 créditos por lead y el primer fetch real costó 6. Lección: medir contra el saldo real y estimar con margen.
- **Ana con 75 puntos (T015):** cargo + sector bastaban para entrar en EN_RADAR sin evidencia de empresa. Lección: los umbrales que promueven exigen señales verificables.
- **Evento sin función (T014):** el sync de Inngest estaba desactualizado y el evento cayó al vacío. Resuelto con la integración de Vercel Marketplace; verificar igualmente con cada función nueva.
- **Token caducado y drift de formato (Fase 2):** el PAT de Supabase caducó durante el parón y la CLI local se actualizó sola. Lección: credenciales sin caducidad y versiones fijadas.
- **Vercel Deployment Protection bloquea integraciones (T018):** el auto-sync de Inngest fallaba en silencio porque su integración hace la llamada contra la URL única del deployment, protegida por Vercel. Se resuelve configurando el Protection Bypass for Automation dentro de la integración. Lección: cualquier integración externa que "no dispara" tras un deploy es candidata a estar chocando con Deployment Protection antes que a bugs propios; verificar en la config de la integración si expone un campo de bypass o dominio de producción.
- **max_tokens truncó el JSON (Nova, sept 2026):** Haiku 4.5 con lote de 20 y `max_tokens=3000` cortaba la respuesta a mitad de la última string. El parser fallaba, el harness liberaba los mismos claims y el loop `un click procesa todos` los volvía a coger → bucle infinito con ~15 llamadas a Haiku desperdiciadas hasta cancelar a mano. Lección triple: (1) toda llamada a IA comprueba `stop_reason`; `max_tokens` es error, no respuesta; (2) un lote que falla NUNCA vuelve al mismo run (columna dedicada `scoring_error` + guard en el claim); (3) verificar el output real con probe local antes de subir un límite, no adivinar.
