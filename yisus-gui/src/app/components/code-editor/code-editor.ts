import { Component, ElementRef, OnDestroy, OnInit, effect, inject, input, output, untracked } from '@angular/core';
import { EditorState, Compartment, Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lintGutter, linter, Diagnostic } from '@codemirror/lint';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';

export type LenguajeEditor = 'javascript' | 'json';
export interface SugerenciaEditor { label: string; detail?: string; info?: string; type?: string }

/**
 * Editor de código (CodeMirror 6): resaltado, números de línea, plegado, cierre de
 * llaves, Tab para indentar, búsqueda (Cmd/Ctrl+F), validación de JSON y, en JS,
 * errores de sintaxis y sugerencias propias (p. ej. args.* y ctx.*).
 */
@Component({
  selector: 'app-code-editor',
  template: ``,
  styles: [`
    :host { display: block; border: 1px solid var(--border-light); border-radius: 10px; overflow: hidden; background: var(--bg-input); }
    :host(:focus-within) { border-color: var(--accent-primary); }
    :host(.invalido) { border-color: var(--danger); }
  `],
  host: { '[class.invalido]': 'invalido()' },
})
export class CodeEditorComponent implements OnInit, OnDestroy {
  private el = inject(ElementRef<HTMLElement>);

  value = input<string>('');
  lenguaje = input<LenguajeEditor>('javascript');
  /** Alto mínimo y máximo (el editor crece con el contenido hasta el máximo y luego scrollea). */
  minAlto = input('160px');
  maxAlto = input('70vh');
  placeholder = input('');
  /** Sugerencias extra para el autocompletado (se evalúan al escribir). */
  sugerencias = input<SugerenciaEditor[]>([]);
  invalido = input(false);
  valueChange = output<string>();

  private view?: EditorView;
  private tema = new Compartment();
  private alto = new Compartment();
  private obs?: MutationObserver;
  /** Evita reemitir cuando el cambio vino de afuera (value → editor). */
  private aplicandoExterno = false;

  constructor() {
    // Si el valor cambia desde afuera (otra herramienta, Descartar), se reemplaza el documento.
    effect(() => {
      const v = this.value() ?? '';
      const view = this.view;
      if (!view) return;
      untracked(() => {
        if (view.state.doc.toString() === v) return;
        this.aplicandoExterno = true;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
        this.aplicandoExterno = false;
      });
    });
    effect(() => {
      const [min, max] = [this.minAlto(), this.maxAlto()];
      this.view?.dispatch({ effects: this.alto.reconfigure(this.temaAlto(min, max)) });
    });
  }

  ngOnInit() {
    const lang = this.lenguaje();
    const extensiones: Extension[] = [
      lineNumbers(), highlightActiveLineGutter(), foldGutter(), history(), drawSelection(),
      indentOnInput(), bracketMatching(), closeBrackets(), highlightActiveLine(), highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      autocompletion({ activateOnTyping: true }),
      keymap.of([indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
      EditorState.tabSize.of(2),
      EditorView.lineWrapping,
      lintGutter(),
      lang === 'json'
        ? [json(), linter(jsonParseLinter(), { delay: 300 })]
        // Las sugerencias propias se suman a las del lenguaje (palabras clave y variables locales).
        : [javascript(), javascriptLanguage.data.of({ autocomplete: (c: CompletionContext) => this.completar(c) }), linter((v) => this.lintJs(v), { delay: 500 })],
      this.tema.of(this.temaColor()),
      this.alto.of(this.temaAlto(this.minAlto(), this.maxAlto())),
      EditorView.updateListener.of((u) => { if (u.docChanged && !this.aplicandoExterno) this.valueChange.emit(u.state.doc.toString()); }),
    ];
    if (this.placeholder()) extensiones.push(cmPlaceholder(this.placeholder()));

    this.view = new EditorView({
      parent: this.el.nativeElement,
      state: EditorState.create({ doc: this.value() ?? '', extensions: extensiones }),
    });

    // El tema claro/oscuro de la app se cambia con una clase en <body>.
    this.obs = new MutationObserver(() => this.view?.dispatch({ effects: this.tema.reconfigure(this.temaColor()) }));
    this.obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  ngOnDestroy() { this.obs?.disconnect(); this.view?.destroy(); }

  private oscuro() { return document.body.classList.contains('dark-theme'); }

  private temaColor(): Extension {
    const base = EditorView.theme({
      '&': { fontSize: '12.5px', backgroundColor: 'transparent' },
      '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.55' },
      '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--border-light)', color: 'var(--text-dim)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(129,140,248,.12)' },
      '.cm-content': { padding: '10px 0' },
      '&.cm-focused': { outline: 'none' },
      '.cm-tooltip': { borderRadius: '8px', overflow: 'hidden' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-primary)', color: '#fff' },
    }, { dark: this.oscuro() });
    return this.oscuro() ? [oneDark, base, EditorView.theme({ '&': { backgroundColor: 'transparent' }, '.cm-gutters': { backgroundColor: 'transparent' } }, { dark: true })] : [base];
  }

  private temaAlto(min: string, max: string): Extension {
    return EditorView.theme({ '&': { minHeight: min, maxHeight: max }, '.cm-scroller': { overflow: 'auto', minHeight: min } });
  }

  /** Errores de sintaxis: se compila como cuerpo de una función async (igual que el sandbox). */
  private lintJs(view: EditorView): Diagnostic[] {
    const code = view.state.doc.toString();
    if (!code.trim()) return [];
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      new AsyncFunction('args', 'ctx', code);
      return [];
    } catch (e: any) {
      if (!(e instanceof SyntaxError)) return [];
      // El navegador no da posición: se marca la última línea con contenido.
      const ultima = view.state.doc.line(view.state.doc.lines);
      return [{ from: Math.max(0, ultima.from), to: ultima.to, severity: 'error', message: `Sintaxis: ${e.message}` }];
    }
  }

  private completar(ctx: CompletionContext): CompletionResult | null {
    const palabra = ctx.matchBefore(/[\w$.]*/);
    if (!palabra || (palabra.from === palabra.to && !ctx.explicit)) return null;
    const texto = palabra.text;
    const opciones = this.sugerencias().filter((s) => s.label.startsWith(texto.includes('.') ? texto.slice(0, texto.lastIndexOf('.') + 1) : ''));
    if (!opciones.length) return null;
    return {
      from: palabra.from,
      options: opciones.map((s) => ({ label: s.label, detail: s.detail, info: s.info, type: s.type || 'property' })),
      validFor: /^[\w$.]*$/,
    };
  }
}
