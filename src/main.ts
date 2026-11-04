import "./style.css";
import { sources, fetchedAt } from "../knowledge.json";
import type { Citation, History } from "../worker/core.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const api = import.meta.env.VITE_API_URL || "http://127.0.0.1:8787";
const history: History = [];
let busy = false,
  sharedAvailable = false;
let connection = { provider: "groq", apiKey: "", model: "" };
let leadId = crypto.randomUUID();
const errorText: Record<string, string> = {
  configuration_required:
    "The shared connection is not configured yet. Open API settings to use your own Groq or OpenRouter key.",
  invalid_api_key:
    "The provider rejected this API key. Check it in API settings.",
  provider_rate_limit:
    "The model provider’s quota is temporarily exhausted. Please wait before trying again, or use your own connection.",
  shared_quota_exhausted:
    "The shared demo has reached its daily allowance. You can continue with your own key in API settings.",
  request_limit:
    "Too many requests in a short time. Please wait before trying again.",
  own_key_required:
    "Please enter your own key for this provider or custom model.",
  invalid_model: "Please check the model identifier in API settings.",
  invalid_request: "Please check the submitted fields and try again.",
  provider_error:
    "The provider could not run this request. Check your model and structured-output support, then try again.",
  invalid_provider_response:
    "The provider returned an incomplete response. Please try again.",
};
const show = (id: string) =>
  $(id) instanceof HTMLDialogElement &&
  ($(id) as HTMLDialogElement).showModal();
for (const id of ["sources", "settings", "quote", "privacy"])
  $(id + "-open").addEventListener("click", () => show(id + "-dialog"));
for (const id of ["sources", "privacy"])
  $("mobile-" + id + "-open").onclick = () => show(id + "-dialog");
$("settings-open").addEventListener("click", () => {
  ($("api-key") as HTMLInputElement).value = connection.apiKey;
});
$("settings-dialog").addEventListener("close", () => {
  ($("api-key") as HTMLInputElement).value = "";
});
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-close]",
))
  button.onclick = () => button.closest("dialog")?.close();
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const box = dialog.getBoundingClientRect();
      if (
        e.clientX < box.left ||
        e.clientX > box.right ||
        e.clientY < box.top ||
        e.clientY > box.bottom
      )
        dialog.close();
    }
  });

$("updated").textContent =
  `Content collected ${new Date(fetchedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}.`;
for (const source of sources) {
  const li = document.createElement("li"),
    a = document.createElement("a");
  a.href = source.url;
  a.textContent = source.title;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  li.append(a);
  $("source-list").append(li);
}
($("contact-link") as HTMLAnchorElement).href = sources[0].url;

function setStatus() {
  const status = $("service-status");
  status.classList.toggle("warning", !connection.apiKey && !sharedAvailable);
  status.textContent = connection.apiKey
    ? `Using your ${connection.provider === "groq" ? "Groq" : "OpenRouter"} key · stored only in tab memory`
    : sharedAvailable
      ? "Shared Groq connection · limited daily allowance"
      : "Shared connection not configured · use your own key in API settings";
}
fetch(api + "/health", { signal: AbortSignal.timeout(10000) })
  .then(async (r) => {
    if (!r.ok) throw new Error();
    const data = await r.json();
    sharedAvailable = Boolean(data.sharedKeyConfigured);
    setStatus();
    if (data.fetchedAt)
      $("updated").textContent =
        `Content collected ${new Date(data.fetchedAt).toLocaleString()}.${data.bundledFallback ? " Using the bundled snapshot; latest repository snapshot could not be loaded." : ""}`;
  })
  .catch(() => {
    $("service-status").textContent =
      "The guide is temporarily unreachable. Please try again shortly.";
    $("service-status").classList.add("warning");
  });

function message(
  role: string,
  text: string,
  citations: Citation[] = [],
  quote = false,
) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent =
    role === "user"
      ? "You"
      : role === "error"
        ? "Connection notice"
        : "PlacidWay Guide";
  const content = document.createElement("div");
  content.className = "message-content";
  content.dir = "auto";
  content.textContent = text;
  article.append(label, content);
  if (citations.length) {
    const details = document.createElement("details");
    details.className = "citations";
    const summary = document.createElement("summary");
    summary.textContent = `View sources & supporting passages (${citations.length})`;
    details.append(summary);
    for (const citation of citations) {
      if (!sources.some((s) => s.url === citation.url)) continue;
      const container = document.createElement("div");
      container.className = "citation";
      const link = document.createElement("a");
      link.href = citation.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = citation.title;
      const heading = document.createElement("small");
      heading.textContent = citation.heading;
      const blockquote = document.createElement("blockquote");
      blockquote.textContent = citation.quote;
      container.append(link, heading, blockquote);
      details.append(container);
    }
    article.append(details);
  }
  if (quote) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const button = document.createElement("button");
    button.className = "text-button";
    button.textContent = "Register quote interest ↗";
    button.onclick = () => show("quote-dialog");
    const link = document.createElement("a");
    link.className = "text-button";
    link.href = sources[0].url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Contact PlacidWay ↗";
    actions.append(button, link);
    article.append(actions);
  }
  $("messages").append(article);
  scroll();
}
function scroll() {
  const el = document.querySelector(".conversation")!;
  el.scrollTop = el.scrollHeight;
}
function setBusy(value: boolean) {
  busy = value;
  $("loading").hidden = !value;
  for (const id of ["send", "reset"])
    ($(id) as HTMLButtonElement).disabled = value;
  ($("question") as HTMLTextAreaElement).disabled = value;
  scroll();
}
async function send(question: string) {
  if (busy || !question.trim()) return;
  $("welcome").hidden = true;
  message("user", question);
  ($("question") as HTMLTextAreaElement).value = "";
  setBusy(true);
  try {
    const response = await fetch(api + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(80000),
      body: JSON.stringify({
        question,
        history: history.slice(-8),
        provider: connection.provider,
        ...(connection.apiKey
          ? { apiKey: connection.apiKey, model: connection.model || undefined }
          : {}),
      }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        errorText[result.error] ||
          "The guide could not complete this request. Please try again shortly.",
      );
    if (typeof result.answer !== "string")
      throw new Error("The guide returned an invalid response.");
    message("assistant", result.answer, result.citations, result.showQuoteForm);
    history.push(
      { role: "user", content: question },
      { role: "assistant", content: result.answer.slice(0, 1600) },
    );
    if (history.length > 8) history.splice(0, history.length - 8);
  } catch (error) {
    message(
      "error",
      error instanceof Error && error.name === "Error"
        ? error.message
        : "Could not reach the guide. Check your connection and try again.",
    );
  } finally {
    setBusy(false);
    ($("question") as HTMLTextAreaElement).focus();
  }
}
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void send(($("question") as HTMLTextAreaElement).value.trim());
});
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ($("chat-form") as HTMLFormElement).requestSubmit();
  }
});
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-question]",
))
  button.onclick = () => void send(button.dataset.question!);
$("reset").onclick = () => {
  if (busy) return;
  history.length = 0;
  $("messages").replaceChildren();
  $("welcome").hidden = false;
  ($("question") as HTMLTextAreaElement).value = "";
  ($("question") as HTMLTextAreaElement).focus();
};
$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const apiKey = ($("api-key") as HTMLInputElement).value.trim();
  connection = {
    provider: ($("provider") as HTMLSelectElement).value,
    apiKey,
    model: apiKey ? ($("model") as HTMLInputElement).value.trim() : "",
  };
  ($("api-key") as HTMLInputElement).value = "";
  ($("settings-dialog") as HTMLDialogElement).close();
  setStatus();
});
$("clear-key").onclick = () => {
  connection = { provider: "groq", apiKey: "", model: "" };
  ($("api-key") as HTMLInputElement).value = "";
  ($("provider") as HTMLSelectElement).value = "groq";
  ($("model") as HTMLInputElement).value = "openai/gpt-oss-120b";
  setStatus();
};
$("lead-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("lead-submit") as HTMLButtonElement;
  button.disabled = true;
  $("lead-result").textContent = "Saving your interest…";
  try {
    const response = await fetch(api + "/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        id: leadId,
        name: ($("lead-name") as HTMLInputElement).value,
        email: ($("lead-email") as HTMLInputElement).value,
        interest: ($("lead-interest") as HTMLSelectElement).value,
        consent: ($("lead-consent") as HTMLInputElement).checked,
        consentVersion: "2026-11-04",
      }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        errorText[result.error] ||
          "Could not save your interest. Please try again.",
      );
    $("lead-result").textContent =
      `Interest recorded in this demo. Reference: ${result.id}. No request was sent to PlacidWay and no appointment was booked.`;
    ($("lead-form") as HTMLFormElement).reset();
    leadId = crypto.randomUUID();
  } catch (error) {
    $("lead-result").textContent =
      error instanceof Error && error.name === "Error"
        ? error.message
        : "Connection failed. You can retry safely; a repeated submission will not create another record.";
  } finally {
    button.disabled = false;
  }
});
