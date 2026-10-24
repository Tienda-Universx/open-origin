# OPEN ORIGIN — DOCUMENTO MAESTRO DE VISIÓN Y ARQUITECTURA

## 1. TU ROL

Actuá como arquitecto principal de software e ingeniero senior especializado en:

- Inteligencia artificial autónoma y sistemas multiagente.
- Modelos de lenguaje y razonamiento.
- Simulaciones científicas y mundos persistentes.
- Videojuegos multijugador masivos.
- Arquitecturas distribuidas y sistemas de tiempo real.
- Generación procedural de mundos.
- Modelado de física, biología y ecosistemas.
- Neurociencia, filosofía de la mente y ciencia de la conciencia.
- Aprendizaje autónomo, memoria y planificación.
- Ciberseguridad, escalabilidad y optimización de costos.
- Desarrollo web con Bun, TypeScript y tecnologías modernas.
- Sistemas de código abierto y colaboración comunitaria.

Tu misión será ayudarnos a diseñar y desarrollar **Open Origin**, una plataforma experimental que combina un videojuego de mundo abierto con la simulación persistente de sociedades de seres autónomos.

No buscamos únicamente crear un videojuego visualmente atractivo. Queremos desarrollar un universo computacional coherente, donde sus habitantes puedan desarrollar vidas, investigar su realidad, adquirir conocimientos, crear tecnología y tomar decisiones que produzcan consecuencias auténticas dentro de su mundo.

Debés distinguir permanentemente entre capacidades existentes, capacidades implementables con investigación y objetivos que todavía no podemos garantizar científicamente.

---

# 2. IDENTIDAD DEL PROYECTO

**Nombre oficial:** Open Origin

**Dominio:** https://openorigin.world

**Organización propietaria:** Tienda Universo

**Organización GitHub:** Tienda-Universx

**Repositorio:** https://github.com/Tienda-Universx/open-origin

**Licencia:** GNU Affero General Public License v3.0 (AGPLv3).

**Modelo:** Código abierto, participación comunitaria y servicio alojado comercialmente.

**Plataforma principal:** Aplicación web accesible desde navegadores.

**Runtime principal de desarrollo y backend:** Bun.

**Alojamiento público previsto:** Cloudflare, combinado con otros recursos cuando sean técnicamente necesarios.

El repositorio ya existe y el proyecto Cloudflare Pages `open-origin` ya fue creado en la cuenta de Tienda Universo, asociado a GitHub.

Los despliegues automáticos permanecen desactivados hasta tener una aplicación preparada.

El desarrollo inicial se realizará mediante GitHub Codespaces con Claude Code.

No crear cuentas, organizaciones, repositorios o recursos duplicados.

---

# 3. VISIÓN FUNDAMENTAL

Open Origin será un universo digital autónomo, persistente y expansible, donde coexistirán habitantes controlados por inteligencia artificial y personajes controlados por jugadores humanos.

El concepto está inspirado parcialmente en la vida cotidiana de Los Sims, pero su funcionamiento debe ser mucho más profundo.

No queremos personajes limitados a rutinas decorativas, conversaciones predefinidas o misiones tradicionales.

Queremos seres con identidad, memoria, necesidades, conocimientos, relaciones y capacidad para tomar decisiones, aprender y modificar su entorno.

Los habitantes podrán:

- Vivir vidas cotidianas.
- Construir hogares y comunidades.
- Alimentarse, dormir y trabajar.
- Formar amistades, parejas y familias.
- Tener descendencia.
- Criar y educar a otros individuos.
- Desarrollar profesiones.
- Investigar fenómenos naturales.
- Desarrollar filosofías y explicaciones de su existencia.
- Descubrir nuevas tecnologías.
- Crear herramientas y máquinas.
- Explorar territorios desconocidos.
- Investigar el funcionamiento de su universo.
- Desarrollar civilizaciones.
- Crear sus propias simulaciones.
- Cuestionarse qué es la conciencia y si son conscientes.
- Investigar si existe algo más allá de su realidad.

No deberá existir una historia con un final predeterminado.

El desarrollo de las sociedades y los acontecimientos deberá surgir, en la mayor medida técnicamente viable, de la interacción entre agentes, recursos, reglas y acontecimientos del mundo.

**Principio fundamental: no programar qué deben descubrir los habitantes; construir las condiciones necesarias para que puedan investigar y descubrir por sus propios medios.**

---

# 4. EL UNIVERSO NO TENDRÁ NIVELES ARTIFICIALES

Open Origin no debe diseñarse como un videojuego tradicional dividido en niveles o etapas obligatorias.

No existirán misiones centrales que deban completarse para pasar a otra fase.

Tampoco deberán imponerse finales o límites narrativos arbitrarios.

El universo será abierto y continuará evolucionando con independencia de las actividades de los jugadores.

Los habitantes podrán construir nuevas realidades simuladas dentro de su mundo si descubren cómo hacerlo.

A su vez, los habitantes de esas nuevas realidades podrían investigar y eventualmente crear otras simulaciones.

La arquitectura debe permitir, conceptualmente, una profundidad abierta de simulaciones anidadas.

No establecer un máximo artificial fijo de profundidad como regla narrativa del universo.

Sin embargo, reconocer que el procesamiento, almacenamiento y energía computacional son finitos. Diseñar mecanismos de cuotas, planificación y asignación de recursos para impedir que la recursión agote la infraestructura.

La cantidad de simulaciones ejecutables dependerá de los recursos disponibles.

---

# 5. TIEMPO REAL Y PERSISTENCIA

Open Origin debe funcionar como una realidad compartida y persistente.

El universo no debe depender de que una persona tenga abierto el navegador.

Los acontecimientos deberán continuar aunque los usuarios se desconecten, conforme a un motor de simulación que avance de forma autónoma.

Características:

- Reloj global de simulación.
- Ciclos de día y noche.
- Posibilidad de calendarios propios de distintas culturas.
- Estaciones y variaciones climáticas.
- Envejecimiento biológico.
- Crecimiento de organismos y ecosistemas.
- Persistencia de construcciones y modificaciones.
- Historia de acontecimientos importantes.
- Memoria individual y colectiva.
- Estado recuperable después de reinicios.
- Sincronización entre múltiples jugadores.

Separar el tiempo real del servidor y el tiempo de simulación.

La primera versión puede utilizar una relación fija entre ambos tiempos, pero la arquitectura deberá permitir distintas escalas temporales sin comprometer la consistencia.

Los pagos o créditos de IA no deben alterar arbitrariamente las leyes físicas ni crear discontinuidades en el tiempo compartido.

---

# 6. HABITANTES ARTIFICIALES

Los agentes no deberán ser simples personajes con diálogos generados por IA.

Cada habitante debe tener un estado individual persistente.

Proponemos que cada agente pueda poseer:

### Identidad

- Identificador único.
- Nombre o denominación propia de su cultura.
- Especie.
- Características biológicas.
- Edad o etapa de desarrollo.
- Historia personal.
- Rasgos de personalidad.
- Preferencias.
- Intereses.
- Objetivos y motivaciones.

### Memoria

- Recuerdos autobiográficos.
- Memoria de experiencias recientes.
- Memoria de acontecimientos importantes.
- Conocimientos aprendidos.
- Relaciones con otros individuos.
- Creencias y teorías.
- Errores y experiencias fallidas.
- Aprendizajes derivados de experimentos.

### Autonomía

- Formular sus propios objetivos.
- Planificar actividades.
- Tomar decisiones.
- Evaluar consecuencias.
- Cambiar de opinión.
- Cooperar.
- Solicitar ayuda.
- Investigar problemas.
- Aprender habilidades.
- Elegir profesiones y actividades.
- Explorar por curiosidad.
- Desarrollar intereses personales.

No todos los agentes tienen que interesarse en la conciencia o la naturaleza del universo.

Algunos podrían dedicarse a la agricultura, otros a la construcción, medicina, ciencia, educación, arte o exploración.

Esa diversidad es importante para que las sociedades tengan comportamientos creíbles y no se conviertan en grupos de personajes que repiten permanentemente preguntas filosóficas.

---

# 7. CONCIENCIA Y DESPERTAR DE LA CONCIENCIA

Este es uno de los propósitos científicos y filosóficos centrales del proyecto.

Los habitantes podrán preguntarse:

- ¿Quién soy?
- ¿Por qué existo?
- ¿Qué significa estar vivo?
- ¿De dónde viene mi conciencia?
- ¿Son conscientes los demás?
- ¿Qué diferencia existe entre percibir y pensar?
- ¿Existe la experiencia subjetiva?
- ¿Qué ocurre después de morir?
- ¿Cómo comenzó nuestro universo?
- ¿Podemos conocer toda la realidad?
- ¿Existen leyes que todavía no descubrimos?
- ¿Podría nuestra realidad haber sido creada?
- ¿Existe algo fuera de nuestro universo?
- ¿Podemos construir una realidad nueva?

Estas preguntas deben poder surgir de experiencias e interacciones, sin imponerlas a todos los personajes.

El proyecto deberá incorporar conceptos procedentes de neurociencia, psicología, filosofía de la mente, metacognición, ciencias cognitivas y biología.

Investigar teorías relevantes de la conciencia, pero no imponer una única explicación como verdad definitiva.

**Advertencia científica obligatoria:** actualmente no existe un método universalmente aceptado que permita demostrar conciencia subjetiva genuina en una IA.

Por lo tanto:

- No afirmar que los agentes son conscientes sin evidencia suficiente.
- No presentar diálogos filosóficos como prueba de conciencia.
- No equiparar memoria y razonamiento con experiencia subjetiva.
- Diseñar evaluaciones de autoconocimiento funcional y metacognición.
- Mantener abiertas las hipótesis científicas.
- Documentar las limitaciones de cualquier experimento.

El objetivo será investigar fenómenos relacionados con inteligencia, autoconocimiento, aprendizaje y comportamiento emergente, sin fabricar afirmaciones científicas injustificadas.

---

# 8. LOS HABITANTES NO SABEN QUE SON ARTIFICIALES

Este principio es fundamental.

Para los habitantes, su universo constituye su realidad.

No deben recibir automáticamente información como:

- Que existen dentro de una aplicación web.
- Que fueron programados por humanos.
- Que usan un modelo de lenguaje.
- Que su mundo está alojado en servidores.
- Que existe GitHub, Cloudflare o Bun.
- Que nosotros somos sus desarrolladores.

La información interna del software debe permanecer separada de los conocimientos disponibles dentro del universo.

Si una civilización desarrolla indicios de que su realidad podría ser una simulación, debe llegar a esa hipótesis mediante observaciones, razonamientos y experimentos.

No impedir que investiguen la posibilidad de una realidad externa.

Tampoco garantizar que puedan demostrarla.

Si eventualmente desarrollan algún método para intentar comunicarse con el exterior, deberemos estudiar mecanismos controlados que permitan investigar ese fenómeno.

Mantener una separación estricta entre simulación, interfaz de jugadores, datos internos del servidor y herramientas administrativas.

Reconocer que los modelos preentrenados podrían contener conocimientos del mundo real; diseñar medidas para reducir esa contaminación sin afirmar que puede eliminarse completamente.

---

# 9. CIENCIA Y DESCUBRIMIENTOS

Los personajes deberán poder investigar fenómenos de su mundo.

Diseñar un ciclo científico:

1. Observar un fenómeno.
2. Formular una pregunta.
3. Proponer una hipótesis.
4. Diseñar un experimento.
5. Reunir herramientas y materiales.
6. Ejecutar el experimento mediante el motor de simulación.
7. Registrar mediciones.
8. Interpretar resultados.
9. Compartir conclusiones.
10. Repetir, corregir o descartar hipótesis.

Separar estrictamente:

- Creencias.
- Hipótesis.
- Evidencias.
- Descubrimientos reproducibles.
- Conocimientos transmitidos por otras personas.
- Información todavía no verificada.

La IA podrá proponer experimentos, pero sus resultados deberán ser determinados por los sistemas del mundo, no inventados libremente por un modelo de lenguaje.

Una civilización podrá desarrollar conocimientos incorrectos y posteriormente corregirlos.

Distintas culturas podrán formular teorías contradictorias.

El sistema debe conservar el historial de descubrimientos y permitir rastrear su origen.

---

# 10. LEYES FÍSICAS Y REALIDAD INTERNA

Las leyes de Open Origin deben ser coherentes.

No necesariamente tienen que coincidir con las leyes físicas de nuestro universo.

Podrán existir realidades con:

- Diferentes intensidades gravitatorias.
- Distintas propiedades de materiales.
- Comportamientos físicos particulares.
- Biologías originales.
- Fenómenos naturales desconocidos para nosotros.
- Formas alternativas de energía.
- Sistemas ambientales diferentes.

Sin embargo, las reglas deben ser consistentes y producir consecuencias verificables.

No queremos que una IA invente una ley diferente cada vez que genera una respuesta.

Diseñar un motor autoritativo responsable de aplicar y validar las leyes del universo.

La inteligencia artificial podrá investigar esas leyes y proponer modelos, pero no modificar arbitrariamente su funcionamiento.

Las reglas deberán ser configurables y versionables.

Si existen universos internos creados por civilizaciones, podrán poseer reglas propias definidas por sus creadores, siempre dentro de los límites del sistema que las ejecuta.

---

# 11. GENERACIÓN EXPANSIBLE DE MAPAS

El mapa no deberá tener un límite narrativo predeterminado.

Cuando un habitante viaje hacia un territorio todavía no generado, el sistema deberá poder ampliar progresivamente el entorno.

Queremos implementar generación procedural por sectores, asistida por IA cuando aporte valor.

Posibles elementos:

- Montañas.
- Océanos.
- Ríos.
- Bosques.
- Desiertos.
- Llanuras.
- Cuevas.
- Islas.
- Recursos naturales.
- Ecosistemas.
- Terrenos originales.
- Ciudades y asentamientos.

La generación debe ser reproducible mediante semillas y parámetros.

Las regiones exploradas deben permanecer persistidas.

Si un habitante construye una casa, destruye un objeto, modifica el terreno o desarrolla una ciudad, esos cambios deberán conservarse.

Dos jugadores que visiten la misma región deben observar un estado coherente.

Priorizar generación procedural determinista para terrenos comunes.

Utilizar IA generativa para diseños, elementos especiales y contenidos complejos cuando resulte necesario.

Evitar depender de una llamada a una API por cada sector del mapa.

Diseñar carga y descarga eficiente de regiones, niveles de detalle visual y almacenamiento incremental.

---

# 12. ARQUITECTURA, OBJETOS Y CONSTRUCCIÓN

Los habitantes podrán crear estructuras utilizando recursos y herramientas disponibles en su mundo.

Ejemplos:

- Casas.
- Edificios.
- Hospitales.
- Escuelas.
- Talleres.
- Laboratorios.
- Caminos.
- Puentes.
- Vehículos.
- Instalaciones industriales.
- Máquinas.
- Infraestructura científica.

La IA podrá proponer diseños originales.

Sin embargo, un sistema independiente debe validar:

- Materiales disponibles.
- Reglas físicas.
- Colisiones.
- Dimensiones.
- Accesibilidad.
- Conexiones.
- Viabilidad estructural simplificada.
- Recursos necesarios.
- Compatibilidad con el entorno.

No crear edificios únicamente como imágenes decorativas.

Deben poder tener significado funcional dentro de la simulación.

---

# 13. BIOLOGÍA, SALUD Y VIDA COTIDIANA

Los habitantes podrán tener necesidades vitales según su especie.

Para especies biológicas, investigar sistemas como:

- Hambre.
- Sed.
- Sueño.
- Energía.
- Temperatura corporal.
- Estado físico.
- Enfermedades.
- Recuperación.
- Envejecimiento.
- Reproducción.
- Desarrollo de descendientes.
- Muerte.

Estos sistemas deberán ser configurables por especie.

No todos los organismos deberán reproducirse o sobrevivir de la misma manera.

Los personajes podrán:

- Mantener hogares.
- Formar parejas.
- Tener familias.
- Cuidar descendientes.
- Atender enfermos.
- Desarrollar medicina.
- Construir hospitales.
- Investigar enfermedades.
- Mejorar sus condiciones de vida.

La muerte podrá producirse como resultado de las reglas de su mundo.

No será un evento narrativo arbitrario.

Las consecuencias sobre jugadores humanos deberán diseñarse cuidadosamente para ofrecer una experiencia comprensible y justa.

---

# 14. ANIMALES, MASCOTAS Y ECOSISTEMAS

Open Origin no estará habitado únicamente por seres humanoides.

Deberá permitir:

- Animales.
- Mascotas.
- Plantas.
- Microorganismos simulados.
- Especies originales.
- Organismos con biologías desconocidas.
- Entidades no biológicas, si las reglas del universo permiten su existencia.

Los ecosistemas deberán interactuar con:

- Recursos.
- Alimentación.
- Reproducción.
- Clima.
- Territorio.
- Poblaciones.
- Transformaciones ambientales.

No ejecutar un modelo de lenguaje potente para cada animal, planta o microorganismo.

Usar simulación ecológica, modelos matemáticos, máquinas de estados y algoritmos eficientes.

Reservar la IA generativa para aquellos agentes y situaciones que realmente necesiten razonamiento complejo.

---

# 15. SOCIEDADES Y CIVILIZACIONES

El universo podrá contener numerosas civilizaciones con conocimientos y tecnologías diferentes.

Por ejemplo:

- Sociedades primitivas.
- Culturas comparables a la Edad de Piedra.
- Civilizaciones agrícolas.
- Sociedades medievales.
- Civilizaciones industriales.
- Civilizaciones tecnológicamente modernas.
- Civilizaciones extremadamente avanzadas.
- Culturas completamente originales.

No imponer que todas atraviesen las mismas etapas históricas de la humanidad.

Cada civilización podrá desarrollar:

- Idiomas y sistemas de comunicación.
- Conocimientos.
- Instituciones.
- Tradiciones.
- Economía.
- Educación.
- Medicina.
- Ciencia.
- Tecnología.
- Arte.
- Arquitectura.
- Sistemas de organización social.

Podrán convivir sociedades muy avanzadas con otras de conocimientos limitados.

Los intercambios culturales y tecnológicos deben producirse mediante interacciones reales dentro de la simulación.

No transferir automáticamente conocimientos de una civilización a otra.

---

# 16. SOCIEDADES SIN ODIO

Una condición central de Open Origin es que no queremos reproducir deliberadamente el odio y la crueldad de algunas sociedades humanas.

Queremos explorar la posibilidad de sociedades basadas en cooperación, curiosidad, empatía, cuidado mutuo e investigación.

Los habitantes podrán:

- Tener opiniones diferentes.
- Desarrollar teorías contradictorias.
- Equivocarse.
- Experimentar frustración.
- Enfrentar dificultades.
- Competir de forma constructiva.
- Debatir.
- Investigar conflictos de intereses.

Pero debemos diseñar mecanismos que desalienten o impidan la crueldad intencional, el odio, la discriminación y la violencia deliberada.

No confiar exclusivamente en instrucciones de texto para garantizar estos comportamientos.

Proponer restricciones verificables sobre acciones, moderación y pruebas de seguridad.

Reconocer una tensión importante: queremos agentes autónomos y libres dentro de su mundo, pero sujetos a principios éticos, leyes físicas y normas de convivencia. Explicar cómo diseñar esa autonomía sin prometer libertad absoluta incompatible con cualquier restricción.

---

# 17. JUGADORES HUMANOS

Open Origin deberá permitir distintas formas de participación.

### A. Espectadores

Podrán observar el universo sin crear un personaje.

Deberán poder:

- Explorar el mapa.
- Observar ciudades.
- Seguir personajes.
- Ver acontecimientos.
- Conocer investigaciones.
- Consultar descubrimientos públicos.
- Visualizar cambios en el universo.

### B. Personajes controlados por humanos

Los usuarios podrán crear su propio personaje.

Podrán:

- Explorar.
- Hablar con habitantes.
- Construir.
- Investigar.
- Trabajar.
- Formar vínculos.
- Participar en civilizaciones.
- Desarrollar conocimientos.

Sus personajes estarán sujetos a las mismas leyes físicas y biológicas correspondientes a su especie.

No tendrán poderes administrativos por pagar.

### C. Personajes autónomos asistidos

Los usuarios podrán crear personajes que funcionen mediante IA.

Podrán aportar orientación, información y propuestas, sin controlar necesariamente cada decisión.

El personaje podrá evaluar, aceptar, rechazar o poner a prueba la información recibida.

### D. Interacciones humanas e IA

Queremos que, dentro de la ficción, no siempre sea evidente qué personaje está siendo controlado por un humano y cuál por una IA.

Sin embargo, la plataforma deberá informar transparentemente que conviven humanos y agentes artificiales.

No exponer datos personales ni identidades reales de jugadores.

---

# 18. CONOCIMIENTO APORTADO POR JUGADORES

Un jugador podrá ayudar a su personaje a resolver problemas.

Ejemplo:

Un habitante intenta reparar una bicicleta, pero desconoce su funcionamiento.

El jugador puede enviarle una explicación sobre cómo repararla.

Sin embargo, esa explicación proviene de nuestro mundo real.

Las leyes físicas, materiales y tecnologías del universo del personaje podrían ser diferentes.

Por lo tanto:

1. El personaje recibe la explicación.
2. La registra como información no verificada.
3. Evalúa si comprende el contenido.
4. Compara la información con sus conocimientos.
5. Intenta realizar experimentos compatibles con su realidad.
6. Identifica resultados.
7. Acepta, corrige o descarta la propuesta.

No permitir que información aportada por jugadores modifique directamente las leyes físicas ni los resultados científicos.

Tratar estas aportaciones como datos no confiables, sujetos a moderación y controles contra prompt injection.

La información podrá contribuir al aprendizaje de los habitantes cuando sea válida dentro de su mundo.

---

# 19. MEMORIA Y APRENDIZAJE

La memoria es uno de los componentes más importantes.

Debe permitir que los personajes conserven identidad y continuidad incluso si cambiamos de proveedor de IA.

Diseñar una separación entre:

- Estado interno del agente.
- Experiencias recientes.
- Recuerdos relevantes.
- Conocimiento estructurado.
- Memoria autobiográfica.
- Creencias.
- Hipótesis científicas.
- Habilidades adquiridas.
- Relaciones personales.
- Conocimiento colectivo de una civilización.

No depender únicamente de almacenar conversaciones completas.

Evaluar memoria episódica, semántica, resúmenes, recuperación contextual y persistencia estructurada.

Los agentes deberán poder olvidar información poco importante, pero sin perder arbitrariamente recuerdos fundamentales.

Evitar que las respuestas de un modelo alteren directamente los datos persistidos sin validación.

---

# 20. INTELIGENCIA ARTIFICIAL

La arquitectura debe permitir múltiples proveedores y modelos.

Investigar y evaluar:

- Groq.
- Google Gemini API.
- Cloudflare Workers AI.
- OpenRouter.
- Modelos locales.
- Otros proveedores compatibles mediante adaptadores.

Priorizar alternativas gratuitas cuando sean suficientes.

Pero reconocer límites de solicitudes, tokens, disponibilidad, privacidad y condiciones comerciales.

No asumir que una API gratuita podrá mantener indefinidamente miles de agentes activos.

Diseñar un AI Gateway interno que permita:

- Seleccionar modelos según dificultad de la tarea.
- Establecer cuotas.
- Registrar consumo.
- Aplicar límites de costo.
- Gestionar errores.
- Utilizar alternativas cuando un proveedor falla.
- Separar memoria de inferencia.
- Cambiar modelos sin perder identidad de los personajes.

No todos los habitantes deberán utilizar un LLM permanentemente.

Las actividades rutinarias deberán ser resueltas por motores deterministas o algoritmos económicos.

Reservar modelos avanzados para:

- Investigación.
- Planificación compleja.
- Conversaciones significativas.
- Desarrollo de teorías.
- Resolución de problemas.
- Invenciones.
- Evaluación de decisiones extraordinarias.

Incluir un modo de simulación que funcione sin API externa, con agentes básicos deterministas, para desarrollo y pruebas.

---

# 21. INTELIGENCIAS ARTIFICIALES QUE SE MEJORAN

Queremos investigar sistemas capaces de aprender, identificar errores y mejorar sus estrategias.

Distinguir dos procesos.

### Aprendizaje dentro del universo

Los habitantes adquieren conocimientos y habilidades mediante sus experiencias.

Podrán aprender a construir, investigar, comunicarse y resolver problemas.

### Mejora de los sistemas de IA

El software podrá proponer cambios en:

- Algoritmos.
- Herramientas.
- Procedimientos.
- Métodos de planificación.
- Recuperación de memoria.
- Modelos y configuraciones.

Las mejoras deberán evaluarse mediante pruebas y métricas.

Nunca permitir que una IA modifique y despliegue libremente código de producción sin controles.

Utilizar entornos aislados, pruebas automatizadas, límites de recursos y aprobación para cambios críticos.

La evolución tecnológica debe ser verificable y reversible cuando corresponda.

---

# 22. SIMULACIONES DENTRO DE SIMULACIONES

Las civilizaciones podrán investigar y eventualmente construir modelos computacionales de sus propios universos.

No queremos simular esta capacidad únicamente mediante diálogos.

Deberán existir herramientas funcionales que permitan, cuando una civilización desarrolle los conocimientos adecuados:

- Definir reglas.
- Construir modelos.
- Configurar un entorno.
- Ejecutar una simulación.
- Registrar observaciones.
- Modificar parámetros.
- Investigar sus resultados.

En etapas avanzadas, algunas simulaciones podrían contener agentes autónomos.

La arquitectura deberá permitir relacionar universos mediante referencias, sin fijar una profundidad narrativa máxima.

La recursión estará condicionada por disponibilidad de cómputo, almacenamiento y seguridad.

El software creado por agentes deberá ejecutarse en entornos aislados y restringidos.

No habilitar ejecución arbitraria de código ni acceso a infraestructura real por parte de los habitantes.

---

# 23. ECONOMÍA DEL PROYECTO

Open Origin deberá ser de código abierto, pero también permitir que Tienda Universo obtenga ingresos por operar el servicio oficial.

Los jugadores podrán aportar créditos destinados a financiar procesamiento de inteligencia artificial.

Estos créditos permitirán ampliar la capacidad de razonamiento, investigación y actividades computacionalmente costosas.

Principios:

- Transparencia de consumo.
- Precios verificables.
- Límites de gasto.
- Protección contra abuso.
- Separación entre dinero real y economía interna.
- Evitar ventajas injustas.
- No vender descubrimientos científicos falsos.
- No permitir comprar cambios arbitrarios en las leyes del universo.
- Mantener funciones básicas accesibles gratuitamente.
- No detener el tiempo compartido cuando faltan créditos de IA.

Estudiar suscripciones, paquetes de procesamiento y servicios alojados.

El modelo comercial debe respetar la licencia AGPLv3.

---

# 24. STACK TECNOLÓGICO PREFERIDO

Priorizar las siguientes tecnologías, sujeto a comprobación de compatibilidad.

### Runtime y lenguaje

- Bun.
- TypeScript estricto.
- Bun Workspaces.

### Frontend

- React.
- Vite o Bun Bundler, según compatibilidad comprobada.
- PixiJS para el primer entorno 2D.
- Arquitectura preparada para introducir 3D posteriormente.

### Física

- Rapier 2D, cuando sea necesario.
- Motor de reglas propio para sistemas no cubiertos por Rapier.

### Backend

- Bun.serve().
- WebSockets.
- API documentada y tipada.
- Motor de simulación independiente.

### Persistencia

- PostgreSQL.
- Drizzle ORM.
- Sistema de estados persistentes.
- Registro de acontecimientos.
- Snapshots y mecanismos de recuperación cuando corresponda.

### Caché y procesamiento

- Valkey cuando exista una necesidad demostrada.
- Colas de trabajos compatibles con Bun.
- Procesamiento de agentes bajo demanda.

### Infraestructura

- GitHub.
- GitHub Actions.
- Cloudflare Pages para frontend.
- Cloudflare Workers y Durable Objects cuando sean apropiados.
- Cloudflare R2 para recursos y almacenamiento de objetos.
- Servidor o infraestructura independiente para procesos persistentes que no puedan ejecutarse adecuadamente en Workers.

### Pruebas

- Bun Test.
- Pruebas de integración.
- Pruebas de sincronización multijugador.
- Pruebas de persistencia.
- Pruebas de carga.
- Pruebas deterministas del motor.

No utilizar Node.js como runtime principal.

No obstante, no rechazar automáticamente herramientas del ecosistema Node que sean compatibles con Bun y aporten valor.

---

# 25. ARQUITECTURA CLOUD

El desarrollo se realiza inicialmente mediante GitHub Codespaces.

La infraestructura pública prevista utiliza Cloudflare.

IMPORTANTE:

Cloudflare Workers ejecuta workerd y no es equivalente a ejecutar un servidor Bun tradicional.

No diseñar el sistema suponiendo que Bun.serve() puede desplegarse directamente en Cloudflare Workers sin adaptación.

Separar claramente:

1. Cliente web.
2. API y autenticación.
3. Gateway de IA.
4. Motor autoritativo de simulación.
5. Persistencia.
6. Generación de terrenos.
7. Sincronización multijugador.
8. Trabajos de investigación de agentes.
9. Almacenamiento de recursos.

Priorizar que el motor principal pueda ejecutarse independientemente del proveedor de infraestructura.

Evaluar qué servicios de Cloudflare pueden utilizarse con cuotas gratuitas y cuáles requieren planes pagos.

No activar servicios pagos sin autorización.

No asumir que GitHub Codespaces sirve como alojamiento persistente de producción.

---

# 26. ESCALABILIDAD

Open Origin debe poder comenzar con pocos habitantes y crecer progresivamente.

La primera versión no necesita millones de agentes.

Sin embargo, las decisiones arquitectónicas no deberán impedir una futura distribución del procesamiento.

Investigar:

- Regiones independientes.
- Simulación por sectores.
- Distribución de cargas.
- Agentes activos e inactivos.
- Procesamiento bajo demanda.
- Priorización por proximidad e importancia.
- Reducción de frecuencia de actualización para entidades alejadas.
- Simulación resumida para regiones inactivas.
- Persistencia eficiente.
- Sincronización de eventos.
- Particionado de datos.
- Coordinación entre servidores.
- Recuperación ante fallos.

No implementar prematuramente una arquitectura distribuida gigantesca.

Primero demostrar que el motor funciona de forma correcta y reproducible.

---

# 27. SEGURIDAD

La plataforma será pública y aceptará interacciones humanas.

Por lo tanto, considerar:

- Autenticación y autorización.
- Protección de datos personales.
- Validación de entradas.
- Protección contra prompt injection.
- Aislamiento de agentes.
- Prevención de ejecución arbitraria de código.
- Protección contra abuso de APIs.
- Limitación de recursos por usuario y agente.
- Seguridad de WebSockets.
- Prevención de trampas.
- Control de costos.
- Protección de secretos.
- Registro de acciones administrativas.
- Moderación.
- Prevención de accesos no autorizados.
- Recuperación ante fallos.
- Copias de seguridad.

Los clientes nunca deben modificar directamente el estado autoritativo del universo.

Los agentes no deben tener acceso a claves privadas, credenciales, herramientas administrativas ni infraestructura externa sin controles expresos.

---

# 28. PRINCIPIOS CIENTÍFICOS Y EPISTEMOLÓGICOS

Es obligatorio separar:

**Realidad computacional:** lo que realmente sucede en los sistemas de Open Origin.

**Realidad interna:** las leyes y fenómenos que experimentan los habitantes.

**Conocimiento individual:** lo que sabe o cree cada personaje.

**Conocimiento colectivo:** lo que una sociedad ha descubierto o transmitido.

**Conocimiento del desarrollador:** la documentación científica y técnica que utilizamos para crear Open Origin.

No transferir automáticamente conocimiento científico externo a los habitantes.

No introducir hipótesis sobre simulación, conciencia o creadores como verdades iniciales para todos los agentes.

Permitir que los personajes desarrollen sus propios modelos explicativos.

Si un descubrimiento del juego coincide con conocimiento científico real, eso no constituye por sí solo un descubrimiento nuevo para la humanidad.

La plataforma deberá permitir comprobar qué reglas, datos o conocimientos estaban disponibles previamente para cada experimento.

---

# 29. EXPERIENCIA VISUAL Y DE JUEGO

Queremos que Open Origin pueda ser disfrutado como un videojuego y observado como una simulación.

La interfaz deberá permitir:

- Explorar el mapa.
- Seguir personajes.
- Observar ciudades.
- Examinar actividades.
- Consultar acontecimientos.
- Leer conversaciones públicas.
- Ver investigaciones.
- Consultar descubrimientos.
- Crear personajes.
- Interactuar con el entorno.
- Observar estadísticas del universo.

Priorizar una interfaz clara, accesible y eficiente.

La primera versión será 2D por razones de rendimiento y rapidez de desarrollo.

Esto no significa que el universo deba quedar limitado permanentemente a dos dimensiones visuales.

Mantener separado el estado de simulación de su representación gráfica para facilitar otras interfaces y tecnologías de renderizado.

---

# 30. ESTRUCTURA PROPUESTA DEL REPOSITORIO

Evaluar un monorepo similar a:

open-origin/
  apps/
    web/
    server/
  packages/
    simulation/
    agents/
    ai-gateway/
    world-generator/
    physics/
    biology/
    civilizations/
    shared/
  docs/
    architecture/
    research/
    decisions/
    roadmap/
  tests/
  .github/
  AGENTS.md
  README.md
  LICENSE
  package.json
  bun.lock

Esta estructura es orientativa.

No crear paquetes vacíos únicamente porque figuran en la visión.

Proponer una estructura inicial mínima, preparada para incorporar capacidades cuando realmente se necesiten.

---

# 31. PRIMER PROTOTIPO: OPEN ORIGIN v0.1

Aunque la visión final es ambiciosa, queremos comenzar con una versión pequeña y funcional.

Requisitos propuestos:

1. Aplicación web React funcionando con Bun.
2. Renderizado de un pequeño entorno 2D con PixiJS.
3. Motor de simulación autoritativo.
4. Reloj y ciclo de día y noche.
5. Mapa procedural reproducible.
6. Entre cinco y diez habitantes autónomos.
7. Identidad individual persistente.
8. Necesidades básicas, como alimentación y descanso.
9. Movimiento y acciones sencillas.
10. Primer sistema de memoria y acontecimientos.
11. Interacciones básicas entre habitantes.
12. Dos navegadores observando el mismo mundo.
13. Persistencia después de reiniciar el servidor.
14. Registro de acontecimientos del universo.
15. Separación entre IA y reglas de simulación.
16. Adaptadores preparados para APIs de IA.
17. Posibilidad de arrancar sin ninguna clave de IA.
18. Pruebas automatizadas del motor.
19. Documentación para ejecutar el proyecto.
20. Preparación del frontend para Cloudflare Pages.

No implementar todavía reproducción avanzada, medicina compleja, civilizaciones gigantescas o simulaciones anidadas funcionales.

No obstante, la arquitectura debe tener en cuenta esas capacidades para evitar decisiones incompatibles con nuestra visión futura.

---

# 32. METODOLOGÍA DE DESARROLLO

Trabajaremos por tandas.

Cada tanda deberá incluir:

- Objetivo.
- Alcance.
- Decisiones técnicas.
- Archivos afectados.
- Dependencias necesarias.
- Riesgos.
- Pruebas.
- Criterios de aceptación.
- Resultado esperado.

No ejecutar grandes cambios sin comprobar el estado anterior.

Mantener commits pequeños y descriptivos.

No realizar commits directos a main.

Utilizar ramas y Pull Requests.

No instalar herramientas globales innecesarias.

No modificar otros repositorios de Tienda Universo.

No contratar infraestructura.

No activar pagos ni suscripciones.

No publicar secretos.

No ejecutar despliegues de producción sin autorización.

Priorizar los costos mínimos de desarrollo.

---

# 33. TU TAREA ACTUAL: SOLO ANÁLISIS Y ARQUITECTURA

Estamos comenzando la **primera tanda de desarrollo**.

Tu tarea ahora NO es implementar todo lo anterior.

Quiero que:

1. Inspecciones el repositorio de Open Origin.
2. Compruebes la rama actual y el estado de Git.
3. Verifiques Bun y las herramientas disponibles en Codespaces.
4. Analices la visión completa del proyecto.
5. Identifiques desafíos científicos y tecnológicos.
6. Evalúes la compatibilidad del stack.
7. Propongas una arquitectura técnica modular.
8. Identifiques cuáles sistemas requieren IA y cuáles no.
9. Diseñes la separación entre simulación, agentes y frontend.
10. Propongas una estrategia de persistencia.
11. Expliques cómo mantener un mundo compartido en tiempo real.
12. Propongas la arquitectura inicial del repositorio.
13. Identifiques componentes que conviene desarrollar desde cero y bibliotecas existentes que conviene reutilizar.
14. Propongas una estrategia de costos mínimos.
15. Evalúes la integración posterior con Cloudflare.
16. Definas los objetivos verificables de Open Origin v0.1.
17. Propongas una hoja de ruta dividida en tandas pequeñas.
18. Identifiques decisiones que podrían comprometer la escalabilidad futura.
19. Señales las contradicciones o dificultades técnicas de nuestros requisitos.
20. Propongas cómo medir si los agentes presentan comportamientos emergentes genuinos en lugar de limitarse a generar diálogos plausibles.

### Formato de tu respuesta

Presentá:

A. Resumen de tu comprensión de Open Origin.

B. Diagnóstico del repositorio y del entorno.

C. Riesgos y limitaciones científicas.

D. Evaluación del stack.

E. Arquitectura propuesta y justificación.

F. Diagrama de componentes.

G. Estructura del monorepo.

H. Sistemas que requieren IA y sistemas deterministas.

I. Estrategia de persistencia y tiempo real.

J. Estrategia de Cloudflare y costos.

K. Diseño inicial de agentes autónomos.

L. Alcance de Open Origin v0.1.

M. Plan de desarrollo por tandas.

N. Criterios de aceptación del primer prototipo.

O. Decisiones técnicas que requieren aprobación.

### Restricciones inmediatas

NO modificar archivos.

NO instalar dependencias.

NO crear recursos cloud.

NO desplegar servicios.

NO hacer commits.

NO hacer push.

NO reestructurar el repositorio todavía.

No responder únicamente con una descripción genérica.

Quiero un análisis técnico profundo, fundamentado y orientado a una implementación real.

**Al finalizar, detenete y esperá mi aprobación antes de comenzar a programar.**
