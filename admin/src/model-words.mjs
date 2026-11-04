/** Fixed model-policy sentences shared by Models and Run; provider response text never enters either (#773). */
import { MODEL_WHY, providerFailureOf } from "@edgehero/pi-dispatch/model-failover-protocol";
import { splitModelEntry } from "@edgehero/pi-dispatch/model-ref";
import { uiText } from "./console/locale.mjs";

const FAILURE_WORDS = Object.freeze({
  "rate-limited": "rate limited",
  "quota-exhausted": "quota exhausted",
  overloaded: "provider overloaded",
  "context-overflow": "context window exceeded",
});
export function providerFailureWords(kind, locale = "en") { return Object.hasOwn(FAILURE_WORDS, kind) ? uiText(FAILURE_WORDS[kind], locale) : null; }

export function providerFailureSentence(value, locale = "en") {
  const failure = providerFailureOf(value);
  if (!failure) return null;
  const sentence = ({
    "rate-limited": "The provider rate limited this model.",
    "quota-exhausted": "The provider's quota was exhausted.",
    overloaded: "The provider was overloaded.",
    "context-overflow": "The request exceeded the model's context window.",
  })[failure.kind] ?? null;
  return sentence === null ? null : uiText(sentence, locale);
}

export function modelChoiceSentence(record, locale = "en") {
  if (!MODEL_WHY.includes(record?.modelWhy)) return null;
  const ref = `${record?.provider}/${record?.model}`;
  if (!splitModelEntry(ref)) return null;
  const role = typeof record.modelRole === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(record.modelRole) ? ` for role ${record.modelRole}` : "";
  if (record.modelWhy === "primary") return locale === "zh"
    ? `本次运行使用 ${ref} 作为主模型${role ? `（角色 ${record.modelRole}）` : ""}。`
    : `This run used ${ref} as its primary model${role}.`;
  const reason = ({
    "fallback-cooldown": "the primary model was cooling down",
    "fallback-window": "the primary model's dollar window had no room",
    "fallback-unavailable": "an earlier candidate was unavailable",
    "fallback-context": "this attempt needed a larger context window",
  })[record.modelWhy];
  if (locale === "zh") {
    const zhReason = ({
      "fallback-cooldown": "主模型仍在冷却期",
      "fallback-window": "主模型的金额窗口没有可用额度",
      "fallback-unavailable": "前一个候选模型不可用",
      "fallback-context": "此次尝试需要更大的上下文窗口",
    })[record.modelWhy];
    return `本次运行使用备用模型 ${ref}${role ? `（角色 ${record.modelRole}）` : ""}，原因：${zhReason}。`;
  }
  return `This run used fallback ${ref}${role} because ${reason}.`;
}
