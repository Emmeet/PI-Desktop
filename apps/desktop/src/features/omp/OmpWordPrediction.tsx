import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import "./omp.css";

let methodPromise: Promise<string> | undefined;
/** omp's `spelling.autocomplete` setting (off | auto | ngram | smollm). */
export function ompWordCompletionMethod(refresh = false): Promise<string> {
  if (!methodPromise || refresh) {
    methodPromise = api
      .ompConfigGet()
      .then((reply) => String(reply.values["spelling.autocomplete"] ?? "auto"))
      .catch(() => "off");
  }
  return methodPromise;
}

/**
 * omp word prediction (`predict_word`) as a hint under the composer: the
 * suffix that completes the word at the cursor. Tab accepts it.
 */
export function OmpWordPrediction({
  editorRef,
  value,
  cursor,
}: {
  editorRef: RefObject<HTMLElement | null>;
  value: string;
  cursor: number;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [suggestion, setSuggestion] = useState<{ text: string; cursor: number; suffix: string } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    void ompWordCompletionMethod().then((method) => setEnabled(method !== "off"));
  }, []);

  useEffect(() => {
    setSuggestion(null);
    if (!enabled) return;
    // Complete a word being typed at the end of the draft only.
    if (cursor !== value.length || !/[\p{L}\p{N}_'-]{2,}$/u.test(value) || value.startsWith("/")) return;
    const id = ++seq.current;
    const timer = setTimeout(() => {
      api
        .ompSessionCommand<{ suffix: string | null }>(undefined, { type: "predict_word", text: value, cursor })
        .then((reply) => {
          if (id === seq.current && reply?.suffix) setSuggestion({ text: value, cursor, suffix: reply.suffix });
        })
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [enabled, value, cursor]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !suggestion) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      // The slash/@ palette owns Tab while it is open.
      if (document.querySelector(".composer-autocomplete")) return;
      event.preventDefault();
      event.stopPropagation();
      document.execCommand("insertText", false, suggestion.suffix);
      void api
        .ompSessionCommand(undefined, { type: "predict_word_feedback", text: suggestion.text, cursor: suggestion.cursor, suggestion: suggestion.suffix, accepted: true })
        .catch(() => undefined);
      setSuggestion(null);
    };
    editor.addEventListener("keydown", onKeyDown, true);
    return () => editor.removeEventListener("keydown", onKeyDown, true);
  }, [editorRef, suggestion]);

  if (!suggestion) return null;
  const word = /[\p{L}\p{N}_'-]+$/u.exec(suggestion.text)?.[0] ?? "";
  return (
    <div className="omp-word-prediction" data-omp-prediction="true" aria-live="polite">
      <kbd>Tab</kbd>
      <span>
        {word}
        <strong>{suggestion.suffix}</strong>
      </span>
      <span className="omp-muted">{t("chat.ompActions.predictHint")}</span>
    </div>
  );
}
