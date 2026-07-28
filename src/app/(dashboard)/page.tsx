// Dashboard home. Chasis únicamente — sin lógica de agentes hasta Fase 1+.

export default function DashboardHome() {
  return (
    <section className="max-w-2xl space-y-4">
      <h1 className="text-4xl font-semibold">Panel</h1>
      <p className="text-sm leading-relaxed text-foreground/60">
        OUTPILOT v2 — herramienta interna de Umania Labs. Elige una sección
        en la barra lateral. Los módulos se activan por fase (Nova, Volt,
        Echo, Sage) y aún no están conectados; esta pantalla y las cuatro
        secciones son el chasis visual.
      </p>
    </section>
  );
}
