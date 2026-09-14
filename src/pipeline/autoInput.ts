export type AutoInputKind = "web" | "text" | "query";

export function detectAutoInputKind(value: string): AutoInputKind {
  const input = value.trim();
  try {
    const url = new URL(input);
    if (url.protocol === "http:" || url.protocol === "https:") return "web";
  } catch {
    // Plain text is handled below.
  }
  return input.length > 80 || /(^|\n)\s{0,3}(?:#|[-*] |\|)|\$\$|\n/u.test(input) ? "text" : "query";
}
