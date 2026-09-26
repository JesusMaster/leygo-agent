import { Component, ElementRef, OnDestroy, OnInit, effect, inject, input, output, untracked } from '@angular/core';
import { EditorState, Compartment, Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder as cmPlaceholder, Decoration, DecorationSet, MatchDecorator, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lintGutter, linter, Diagnostic } from '@codemirror/lint';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';

export type LenguajeEditor = 'javascript' | 'json' | 'markdown';
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
  /** Palabras a destacar (p. ej. nombres de herramientas mencionados en la personalidad). */
  resaltar = input<string[]>([]);
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
    const prosa = lang === 'markdown';
    const extensiones: Extension[] = [
      // En prosa no hay números de línea: el margen solo pliega secciones (# Títulos).
      prosa ? [] : [lineNumbers(), highlightActiveLineGutter()],
      foldGutter(), history(), drawSelection(),
      prosa ? [] : [indentOnInput(), bracketMatching(), closeBrackets(), highlightActiveLine()],
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      autocompletion({ activateOnTyping: true }),
      keymap.of([indentWithTab, ...(prosa ? [] : closeBracketsKeymap), ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
      EditorState.tabSize.of(2),
      EditorView.lineWrapping,
      lang === 'json'
        ? [lintGutter(), json(), linter(jsonParseLinter(), { delay: 300 })]
        : lang === 'markdown'
          ? [markdown({ base: markdownLanguage }), markdownLanguage.data.of({ autocomplete: (c: CompletionContext) => this.completar(c) }), syntaxHighlighting(estiloProsa), this.resaltador()]
          // Las sugerencias propias se suman a las del lenguaje (palabras clave y variables locales).
          : [lintGutter(), javascript(), javascriptLanguage.data.of({ autocomplete: (c: CompletionContext) => this.completar(c) }), linter((v) => this.lintJs(v), { delay: 500 })],
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
    const prosa = this.lenguaje() === 'markdown';
    const base = EditorView.theme({
      '&': { fontSize: prosa ? '14.5px' : '12.5px', backgroundColor: 'transparent' },
      '.cm-scroller': prosa
        ? { fontFamily: 'var(--font-main), system-ui, sans-serif', lineHeight: '1.7' }
        : { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.55' },
      '.cm-content': { padding: prosa ? '16px 22px 16px 4px' : '10px 0', maxWidth: prosa ? '980px' : 'none' },
      '.cm-resaltada': { color: 'var(--accent-primary)', backgroundColor: 'rgba(129,140,248,.12)', borderRadius: '4px', padding: '0 3px', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '.9em' },
      '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--border-light)', color: 'var(--text-dim)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(129,140,248,.12)' },
      '&.cm-focused': { outline: 'none' },
      '.cm-tooltip': { borderRadius: '8px', overflow: 'hidden' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-primary)', color: '#fff' },
    }, { dark: this.oscuro() });
    return this.oscuro() ? [oneDark, base, EditorView.theme({ '&': { backgroundColor: 'transparent' }, '.cm-gutters': { backgroundColor: 'transparent' } }, { dark: true })] : [base];
  }

  private temaAlto(min: string, max: string): Extension {
    return EditorView.theme({ '&': { minHeight: min, maxHeight: max }, '.cm-scroller': { overflow: 'auto', minHeight: min } });
  }

  /** Destaca las palabras de `resaltar` (nombres de herramientas) dentro del texto. */
  private resaltador(): Extension {
    const comp = this;
    const deco = Decoration.mark({ class: 'cm-resaltada' });
    return ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      private firma = '';
      private md: MatchDecorator | null = null;
      constructor(view: EditorView) { this.decorations = this.crear(view); }
      private crear(view: EditorView): DecorationSet {
        const palabras = comp.resaltar().filter(Boolean);
        this.firma = palabras.join('|');
        if (!palabras.length) { this.md = null; return Decoration.none; }
        const re = new RegExp(`\\b(${palabras.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
        this.md = new MatchDecorator({ regexp: re, decoration: () => deco });
        return this.md.createDeco(view);
      }
      update(u: ViewUpdate) {
        if (comp.resaltar().join('|') !== this.firma) this.decorations = this.crear(u.view);
        else if (this.md && (u.docChanged || u.viewportChanged)) this.decorations = this.md.updateDeco(u, this.decorations);
      }
    }, { decorations: (v) => v.decorations });
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
    if (this.lenguaje() === 'markdown') {
      const w = ctx.matchBefore(/[a-z_][a-z0-9_]{2,}/i);
      if (!w && !ctx.explicit) return null;
      const lista = this.sugerencias();
      if (!lista.length) return null;
      return { from: w ? w.from : ctx.pos, options: lista.map((s) => ({ label: s.label, detail: s.detail, info: s.info, type: s.type || 'function' })), validFor: /^[\w]*$/ };
    }
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

/** Markdown legible: títulos marcados, listas y citas con color, énfasis real. */
const estiloProsa = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.3em', fontWeight: '700', color: 'var(--text-main)' },
  { tag: tags.heading2, fontSize: '1.15em', fontWeight: '700', color: 'var(--text-main)' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '700', color: 'var(--text-main)' },
  { tag: tags.processingInstruction, color: 'var(--accent-primary)' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.quote, color: 'var(--text-dim)', fontStyle: 'italic' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '.9em', color: '#f59e0b' },
  { tag: tags.link, color: 'var(--link-color)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--text-dim)' },
  { tag: tags.contentSeparator, color: 'var(--text-dim)' },
]);
