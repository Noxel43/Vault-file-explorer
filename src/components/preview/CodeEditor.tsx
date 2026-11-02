import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

// Colours are CSS variables so the viewer follows theme swaps with no re-render.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.attributeValue], color: "var(--syn-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color], color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--syn-type)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--syn-tag)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--syn-property)" },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: "var(--syn-meta)" },
  { tag: [t.heading], color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: [t.strong], fontWeight: "600" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--accent)", textDecoration: "underline" },
  { tag: [t.invalid], color: "var(--danger)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", background: "transparent", color: "var(--text)", fontSize: "var(--fs-sm)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55", overflow: "auto" },
  ".cm-content": { userSelect: "text", padding: "8px 0" },
  ".cm-gutters": { background: "transparent", color: "var(--text-faint)", border: "0", paddingLeft: "4px" },
  ".cm-line": { padding: "0 12px 0 6px" },
});

/** Read-only, virtualised viewer: only the lines on screen exist in the DOM. */
export default function CodeEditor({ text, fileName, wrap }: { text: string; fileName: string; wrap: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapping = useRef(new Compartment());

  useEffect(() => {
    const language = new Compartment();
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers(),
          theme,
          syntaxHighlighting(highlight),
          language.of([]),
          wrapping.current.of(wrap ? EditorView.lineWrapping : []),
        ],
      }),
    });
    viewRef.current = view;

    // Grammars are separate chunks, fetched the first time a file of that language is shown.
    let cancelled = false;
    LanguageDescription.matchFilename(languages, fileName)
      ?.load()
      .then((support) => {
        if (!cancelled) view.dispatch({ effects: language.reconfigure(support) });
      })
      .catch(console.error);

    return () => {
      cancelled = true;
      viewRef.current = null;
      view.destroy();
    };
  }, [text, fileName]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  return <div ref={hostRef} className="preview-code" />;
}
