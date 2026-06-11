import { z } from "zod";

const DISALLOWED_SINGLE_LINE_CONTROL = /\p{Cc}/u;
const DISALLOWED_MULTI_LINE_CONTROL = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const DISALLOWED_FORMAT_OR_PRIVATE = /[\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;
const DISALLOWED_EMOJI = /\p{Extended_Pictographic}/u;
const DISALLOWED_COMBINING_MARK = /\p{M}/u;
const ALLOWED_EMOJI_BASE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;
const ALLOWED_EMOJI_COMPONENT = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u20E3]/gu;
const EMOJI_COMPONENT_WITHOUT_BASE = /[\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u20E3]/u;

export interface SafeTextOptions {
  allowEmpty?: boolean;
  allowEmoji?: boolean;
  maxBytes?: number;
  maxChars: number;
  multiline?: boolean;
}

export function normalizeUserText(value: string, options: Pick<SafeTextOptions, "multiline"> = {}): string {
  const normalized = value.normalize("NFKC");
  return options.multiline ? normalized.replace(/\r\n?/g, "\n").trim() : normalized.trim();
}

export function safeText(options: SafeTextOptions) {
  const maxBytes = options.maxBytes ?? options.maxChars * 4;
  return z
    .string()
    .transform((value) => normalizeUserText(value, options))
    .superRefine((value, ctx) => {
      if (value.length === 0) {
        if (!options.allowEmpty) {
          ctx.addIssue({ code: z.ZodIssueCode.too_small, minimum: 1, type: "string", inclusive: true, message: "Required" });
        }
        return;
      }

      if (Array.from(value).length > options.maxChars) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: options.maxChars,
          type: "string",
          inclusive: true,
          message: "Text is too long"
        });
      }

      if (new TextEncoder().encode(value).byteLength > maxBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: maxBytes,
          type: "string",
          inclusive: true,
          message: "Text is too large"
        });
      }

      const hasControl = options.multiline
        ? DISALLOWED_MULTI_LINE_CONTROL.test(value)
        : DISALLOWED_SINGLE_LINE_CONTROL.test(value);
      const unsupportedText = options.allowEmoji ? value.replace(ALLOWED_EMOJI_COMPONENT, "") : value;
      const hasOrphanEmojiComponent =
        options.allowEmoji && EMOJI_COMPONENT_WITHOUT_BASE.test(value) && !ALLOWED_EMOJI_BASE.test(value);

      if (hasControl || hasOrphanEmojiComponent || DISALLOWED_FORMAT_OR_PRIVATE.test(unsupportedText) || DISALLOWED_COMBINING_MARK.test(unsupportedText)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Text contains unsupported characters"
        });
      }

      if (!options.allowEmoji && DISALLOWED_EMOJI.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Text contains unsupported characters"
        });
      }
    });
}

export const resourceIdSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9:_-]+$/);
export const periodKeySchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^(?:(daily|weekly|biweekly|custom):\d{4}-\d{2}-\d{2}|none:permanent)$/);
