export interface RedactionResult {
  text: string;
  count: number;
  kinds: string[];
}
export function redactSecrets(text: string): RedactionResult {
  let count = 0;
  const kinds = new Set<string>();
  const replace = (pattern: RegExp, kind: string): void => {
    text = text.replace(pattern, () => {
      count++;
      kinds.add(kind);
      return `[REDACTED:${kind}]`;
    });
  };
  replace(
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
    "private-key",
  );
  replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "aws");
  replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    "github",
  );
  replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, "api-key");
  replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "slack");
  replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, "google");
  replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "jwt");
  replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "bearer");
  text = text.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    (_, scheme: string) => {
      count++;
      kinds.add("url-credentials");
      return `${scheme}[REDACTED:url-credentials]@`;
    },
  );
  text = text.replace(
    /\b(api[_-]?key|secret|token|passw(?:or)?d|pwd)(["']?\s*[:=]\s*)(["']?)([^\s"'`,;]+)\3/gi,
    (match, key: string, separator: string, quote: string, value: string) => {
      if (
        (!quote && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) ||
        value.startsWith("[REDACTED:") ||
        value.length < 8 ||
        !/^[A-Za-z0-9_./+@=-]+$/.test(value) ||
        /^(?:true|false|null|undefined)$/i.test(value)
      )
        return match;
      count++;
      kinds.add("generic");
      return `${key}${separator}${quote}[REDACTED:generic]${quote}`;
    },
  );
  return { text, count, kinds: [...kinds] };
}
