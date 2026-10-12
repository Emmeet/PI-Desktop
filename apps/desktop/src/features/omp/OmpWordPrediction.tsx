import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { editorSelectionRange, readEditorValue } from "../chat/composer/editor";
import { subscribeOmpConfig } from "./preferences";
import { acceptWordSuggestion, WordPredictionRequests, wordPredictionEligible, wordSuggestionMatches, type WordSuggestion } from "./word-prediction";
import "./omp.css";

/**
 * omp word prediction (`predict_word`) as a hint under the composer: the
 * suffix that completes the word at the cursor. Tab accepts it.
 */
export function OmpWordPrediction({
  editorRef,
  value,
  cursor,
  sessionId,
  composing,
  blocked,
  paletteOpen,
  onAccept,
}: {
  editorRef: RefObject<HTMLElement | null>;
  value: string;
  cursor: number;
  sessionId: string;
  composing: boolean;
  blocked: boolean;
  paletteOpen: boolean;
  onAccept: (suffix: string) => boolean;
}) {
  const { t } = useTranslation();
  const [method, setMethod] = useState("off");
  const [suggestion, setSuggestion] = useState<WordSuggestion | null>(null);
  const requests = useRef(new WordPredictionRequests());
  const input = { sessionId, text: value, cursor, composing, blocked, method };
  const latest = useRef({ input, paletteOpen, onAccept });
  latest.current = { input, paletteOpen, onAccept };

  useEffect(() => {
    let live = true;
    let generation = 0;
    const refresh = () => {
      const id = ++generation;
      requests.current.invalidate();
      setSuggestion(null);
      setMethod("off");
      void api.ompConfigGet().then((reply) => {
        if (live && id === generation) setMethod(String(reply.values["spelling.autocomplete"] ?? "auto"));
      }).catch(() => undefined);
    };
    refresh();
    const stop = subscribeOmpConfig(api, refresh);
    return () => {
      live = false;
      ++generation;
      stop();
      requests.current.invalidate();
    };
  }, [sessionId]);

  useEffect(() => {
    requests.current.invalidate();
    setSuggestion(null);
    if (!wordPredictionEligible(input) || paletteOpen) return;
    const timer = setTimeout(() => {
      void requests.current.request(input, (query) => api.ompSessionCommand<{ suffix: string | null }>(query.sessionId, {
        type: "predict_word", text: query.text, cursor: query.cursor,
      })).then((next) => {
        if (next && !latest.current.paletteOpen && wordSuggestionMatches(next, latest.current.input)) setSuggestion(next);
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      requests.current.invalidate();
    };
  }, [method, value, cursor, composing, blocked, paletteOpen, sessionId]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !suggestion) return;
    let consumed = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (consumed || document.activeElement !== editor) return;
      const live = latest.current;
      const selection = editorSelectionRange(editor);
      if (readEditorValue(editor) !== live.input.text || selection.start !== live.input.cursor || selection.end !== selection.start) return;
      if (!acceptWordSuggestion(event, suggestion, live.input, live.paletteOpen, live.onAccept)) return;
      consumed = true;
      requests.current.invalidate();
      setSuggestion(null);
      void api.ompSessionCommand(suggestion.input.sessionId, {
        type: "predict_word_feedback", text: suggestion.input.text, cursor: suggestion.input.cursor,
        suggestion: suggestion.suffix, accepted: true,
      }).catch(() => undefined);
    };
    editor.addEventListener("keydown", onKeyDown, true);
    return () => editor.removeEventListener("keydown", onKeyDown, true);
  }, [editorRef, suggestion]);

  if (!suggestion || paletteOpen || !wordSuggestionMatches(suggestion, input)) return null;
  const word = /[\p{L}\p{N}_'-]+$/u.exec(suggestion.input.text)?.[0] ?? "";
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
