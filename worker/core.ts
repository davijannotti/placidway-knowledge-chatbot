export type Chunk = {
  id: string;
  sourceId: string;
  title: string;
  heading: string;
  url: string;
  text: string;
};
export type Citation = {
  id: string;
  title: string;
  heading: string;
  url: string;
  quote: string;
};
export type History = { role: "user" | "assistant"; content: string }[];
export type Language = "en" | "pt" | "es" | "ar";
export const normalize = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const stop = new Set(
  "a an the is are of in at on to for and or it i my me how much what about does do can you with this that treatment alternative cancer package packages itc tijuana mexico program patient".split(
    " ",
  ),
);
const tokens = (s: string) =>
  normalize(s)
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((w) => w.length > 1 && !stop.has(w)) ?? [];

export function retrieve(
  query: string,
  chunks: Chunk[],
  maxChars = 8500,
): Chunk[] {
  const requested = [
    ["adenocarcinoma", "2"],
    ["adrenal", "3"],
    ["anal", "4"],
  ]
    .filter(([word]) => new RegExp(`\\b${word}\\b`, "i").test(query))
    .map(([, source]) => source);
  if (requested.length)
    chunks = chunks.filter(
      (c) =>
        !["2", "3", "4"].includes(c.sourceId) || requested.includes(c.sourceId),
    );
  const words = [...new Set(tokens(query))];
  const counts = chunks.map((c) => tokens(c.text));
  const df = new Map(
    words.map((w) => [w, counts.filter((t) => t.includes(w)).length]),
  );
  const scored = chunks
    .map((chunk, i) => {
      const heading = tokens(chunk.heading),
        title = tokens(chunk.title);
      let score = 0;
      for (const w of words) {
        const n = counts[i].filter((t) => t === w).length;
        if (n)
          score +=
            (1 + Math.log(n)) * Math.log(1 + chunks.length / (df.get(w) || 1));
        if (heading.includes(w)) score += 5;
        if (title.includes(w)) score += 2;
      }
      return { chunk, score: score / Math.sqrt(20 + counts[i].length) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const selected: Chunk[] = [];
  let size = 0;
  for (const { chunk } of scored) {
    const length = JSON.stringify(chunk).length;
    if (size + length <= maxChars && selected.length < 7) {
      selected.push(chunk);
      size += length;
    }
  }
  return selected;
}

export function validateHistory(value: unknown): History {
  if (!Array.isArray(value) || value.length > 8)
    throw new Error("invalid_history");
  return value.map((m) => {
    if (
      !m ||
      !["user", "assistant"].includes(m.role) ||
      typeof m.content !== "string" ||
      m.content.length > 1600
    )
      throw new Error("invalid_history");
    return { role: m.role, content: m.content };
  });
}

export function validateLead(body: Record<string, unknown>) {
  if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id))
    throw new Error("invalid_lead");
  if (body.consent !== true || body.consentVersion !== "2026-11-04")
    throw new Error("consent_required");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const interest =
    typeof body.interest === "string" ? body.interest.trim() : "";
  if (
    name.length < 2 ||
    name.length > 100 ||
    /[\r\n\x00-\x1f]/.test(name) ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    interest.length > 150
  )
    throw new Error("invalid_lead");
  return { id: body.id, name, email, interest };
}

export function redactQuestion(text: string) {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(?:sk-|gsk_)[\w-]+/g, "[key]")
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, "[number]")
    .replace(
      /\b(?:my name is|me chamo|meu nome é|mi nombre es)\s+[^,.!?\n]+/gi,
      "[name]",
    )
    .slice(0, 400);
}

const numbers = (s: string) =>
  (s.match(/\d[\d,.]*/g) ?? []).map((n) =>
    n.replace(/[,.]$/g, "").replace(/,/g, ""),
  );
export function validateAnswer(value: unknown, selected: Chunk[]) {
  const obj = value as {
    status?: string;
    claims?: { text: string; sourceId: string; quote: string }[];
  };
  if (
    !obj ||
    !["answered", "unknown"].includes(obj.status || "") ||
    !Array.isArray(obj.claims) ||
    obj.claims.length > 6
  )
    throw new Error("invalid_answer");
  if (obj.status === "unknown")
    return { status: "unknown", answer: "", citations: [] as Citation[] };
  if (!obj.claims.length) throw new Error("missing_evidence");
  const citations: Citation[] = [];
  const lines: string[] = [];
  for (const claim of obj.claims) {
    const source = selected.find((c) => c.id === claim.sourceId);
    if (
      !source ||
      typeof claim.text !== "string" ||
      !claim.text.trim() ||
      claim.text.length > 600 ||
      typeof claim.quote !== "string" ||
      claim.quote.length < 15 ||
      claim.quote.length > 1800 ||
      /https?:\/\//i.test(claim.text)
    )
      throw new Error("invalid_evidence");
    const flatten = (s: string) =>
      s
        .replace(/\\[nrt]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    let quote = claim.quote.replace(/\\n/g, "\n");
    // The exact heading is displayed separately; allow it as a redundant quote prefix.
    if (quote.startsWith(source.heading))
      quote = quote.slice(source.heading.length).trim();
    if (quote.length < 15 || !flatten(source.text).includes(flatten(quote)))
      throw new Error("unsupported_quote");
    const evidenceNumbers = numbers(source.heading + " " + quote);
    if (numbers(claim.text).some((n) => !evidenceNumbers.includes(n)))
      throw new Error("unsupported_number");
    citations.push({
      id: source.id,
      title: source.title,
      heading: source.heading,
      url: source.url,
      quote,
    });
    lines.push(claim.text.trim());
  }
  return { status: "answered", answer: lines.join("\n\n"), citations };
}

export const messages = {
  en: {
    unknown:
      "I couldn't find that information in the seven supplied PlacidWay pages. Please contact PlacidWay for a free, personalized quote.",
    medical:
      "I can't assess whether a treatment is safe or suitable for your health condition. Please discuss this with your treating doctor and the clinic's qualified medical team. Website descriptions are not proof of effectiveness or safety.",
    booking:
      "I can't book appointments or confirm availability. You can contact PlacidWay through the clinic page to request a consultation or a free quote.",
    out_of_scope:
      "I can help with the clinic, packages and prices described in the seven supplied PlacidWay pages. Please ask a question about that content.",
    greeting:
      "Hello! Ask me about ITC's listed packages, prices, inclusions or travel information. I'll link to the source for each factual answer.",
    quote:
      "You can register your interest using the quote form below, or contact PlacidWay directly through the clinic page. This demonstration cannot book treatment or send your request to PlacidWay.",
  },
  pt: {
    unknown:
      "Não encontrei essa informação nas sete páginas fornecidas da PlacidWay. Entre em contato com a PlacidWay para uma cotação gratuita e personalizada.",
    medical:
      "Não posso avaliar se um tratamento é seguro ou adequado para sua condição de saúde. Converse com seu médico e com a equipe médica qualificada da clínica. Descrições do site não comprovam eficácia ou segurança.",
    booking:
      "Não posso agendar consultas nem confirmar disponibilidade. Você pode entrar em contato com a PlacidWay pela página da clínica para solicitar uma consulta ou cotação gratuita.",
    out_of_scope:
      "Posso ajudar com a clínica, os pacotes e os preços descritos nas sete páginas fornecidas da PlacidWay. Faça uma pergunta sobre esse conteúdo.",
    greeting:
      "Olá! Pergunte sobre os pacotes, preços, inclusões ou informações de viagem do ITC. Cada resposta factual terá um link para a fonte.",
    quote:
      "Você pode registrar seu interesse no formulário abaixo ou contatar a PlacidWay pela página da clínica. Esta demonstração não agenda tratamentos nem envia sua solicitação à PlacidWay.",
  },
  es: {
    unknown:
      "No encontré esa información en las siete páginas proporcionadas de PlacidWay. Contacte a PlacidWay para una cotización gratuita y personalizada.",
    medical:
      "No puedo evaluar si un tratamiento es seguro o adecuado para su condición de salud. Consulte a su médico y al equipo médico de la clínica. Las descripciones del sitio no demuestran eficacia ni seguridad.",
    booking:
      "No puedo reservar citas ni confirmar disponibilidad. Contacte a PlacidWay desde la página de la clínica para solicitar una consulta o cotización gratuita.",
    out_of_scope:
      "Puedo ayudar con la clínica, los paquetes y los precios descritos en las siete páginas proporcionadas de PlacidWay.",
    greeting:
      "¡Hola! Pregunte sobre los paquetes, precios, servicios incluidos o viajes de ITC. Cada respuesta incluirá su fuente.",
    quote:
      "Puede registrar su interés en el formulario o contactar a PlacidWay desde la página de la clínica. Esta demostración no reserva tratamientos ni envía solicitudes a PlacidWay.",
  },
  ar: {
    unknown:
      "لم أجد هذه المعلومات في صفحات PlacidWay السبع المقدمة. يرجى التواصل مع PlacidWay للحصول على عرض سعر مجاني ومخصص.",
    medical:
      "لا أستطيع تقييم مدى أمان العلاج أو ملاءمته لحالتك الصحية. يرجى استشارة طبيبك والفريق الطبي المؤهل في العيادة. أوصاف الموقع ليست دليلاً على الفعالية أو السلامة.",
    booking:
      "لا أستطيع حجز المواعيد أو تأكيد التوفر. تواصل مع PlacidWay عبر صفحة العيادة لطلب استشارة أو عرض سعر مجاني.",
    out_of_scope:
      "يمكنني المساعدة بشأن العيادة والباقات والأسعار المذكورة في صفحات PlacidWay السبع المقدمة.",
    greeting:
      "مرحباً! اسأل عن باقات ITC والأسعار والخدمات المشمولة والسفر. سأرفق مصدر كل إجابة واقعية.",
    quote:
      "يمكنك تسجيل اهتمامك في النموذج أو التواصل مباشرة مع PlacidWay عبر صفحة العيادة. هذا العرض التجريبي لا يحجز العلاج ولا يرسل طلبك إلى PlacidWay.",
  },
};
