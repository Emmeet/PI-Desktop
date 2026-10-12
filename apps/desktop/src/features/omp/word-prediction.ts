export type WordPredictionInput = {
  sessionId: string;
  text: string;
  cursor: number;
  composing: boolean;
  blocked: boolean;
  method: string;
};
export type WordSuggestion = { input: WordPredictionInput; suffix: string };

export function wordPredictionEligible(input: WordPredictionInput): boolean {
  return input.method !== "off" && !input.composing && !input.blocked &&
    input.cursor === input.text.length && !input.text.trimStart().startsWith("/") &&
    !/(?:^|\s)@\S*$/u.test(input.text) && /[\p{L}\p{N}_'-]{2,}$/u.test(input.text);
}

export function wordSuggestionMatches(suggestion: WordSuggestion, input: WordPredictionInput): boolean {
  return wordPredictionEligible(input) && suggestion.input.sessionId === input.sessionId &&
    suggestion.input.text === input.text && suggestion.input.cursor === input.cursor &&
    suggestion.input.method === input.method;
}

/** Invalidating on every draft/settings transition also cancels stale in-flight responses. */
export class WordPredictionRequests {
  private generation = 0;

  invalidate(): void {
    ++this.generation;
  }

  async request(input: WordPredictionInput, predict: (input: WordPredictionInput) => Promise<{ suffix: string | null }>): Promise<WordSuggestion | null> {
    const generation = ++this.generation;
    if (!wordPredictionEligible(input)) return null;
    try {
      const reply = await predict(input);
      if (generation !== this.generation || !reply?.suffix || !/^[\p{L}\p{N}_'-]+$/u.test(reply.suffix)) return null;
      return { input, suffix: reply.suffix };
    } catch {
      return null;
    }
  }
}

/** A suggestion is inserted once; feedback is sent only after the draft accepts it. */
export function acceptWordSuggestion(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "defaultPrevented" | "repeat" | "preventDefault" | "stopImmediatePropagation">,
  suggestion: WordSuggestion,
  input: WordPredictionInput,
  paletteOpen: boolean,
  insert: (suffix: string) => boolean,
): boolean {
  if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ||
    event.isComposing || event.defaultPrevented || event.repeat || paletteOpen || !wordSuggestionMatches(suggestion, input)) return false;
  if (!insert(suggestion.suffix)) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}
