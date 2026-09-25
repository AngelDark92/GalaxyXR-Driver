import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Execute the real adapters and pinned Fluent class methods without a browser.
// Only Lit registration/rendering and FAST's DOM/observer plumbing are stubbed;
// Fluent's value setters, normalization, and keyboard behavior remain real.
const guiRoot = new URL('../../', import.meta.url);
const noop = () => {};

function harness() {
  class MockLitElement {
    isConnected = true;
    emitted: Array<{ type: string; detail: unknown }> = [];
    closest() { return null; }
    dispatchEvent(event: { type: string; detail: unknown }) {
      this.emitted.push({ type: event.type, detail: event.detail });
      return true;
    }
  }
  const context = createContext({
    console, setTimeout, clearTimeout,
    CustomEvent: class {
      constructor(public type: string, options: object) { Object.assign(this, options); }
    },
    FASTElement: class { attachInternals() { return {}; } }, Observable: { track: noop, notify: noop },
    limit: (min: number, max: number, value: number) => Math.min(max, Math.max(min, value)),
    Direction: { ltr: 'ltr', rtl: 'rtl' },
    Orientation: { horizontal: 'horizontal', vertical: 'vertical' },
    SliderOrientation: { horizontal: 'horizontal', vertical: 'vertical' },
    SliderMode: { singleValue: 'single-value' },
    window: { addEventListener: noop, removeEventListener: noop },
    document: { addEventListener: noop, removeEventListener: noop, documentElement: { scrollLeft: 0, scrollTop: 0 } },
  });
  function nativeClass(relativePath: string, name: string): any {
    const filename = fileURLToPath(new URL(`node_modules/@fluentui/web-components/dist/esm/${relativePath}`, guiRoot));
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
    const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`Missing installed Fluent class ${name}`);
    return runInContext(`${declaration.getText(source).replace(/^export /, '')}\n${name}`, context);
  }
  const Slider = nativeClass('slider/slider.js', 'Slider');
  const Dropdown = nativeClass('dropdown/dropdown.base.js', 'BaseDropdown');
  const utilitySource = ts.createSourceFile('slider-utilities.js', readFileSync(new URL(
    'node_modules/@fluentui/web-components/dist/esm/slider/slider-utilities.js', guiRoot), 'utf8'), ts.ScriptTarget.ES2022, true);
  const conversion = utilitySource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'convertPixelToPercent');
  if (!conversion) throw new Error('Missing installed Fluent slider conversion');
  runInContext(conversion.getText(utilitySource).replace(/^export /, ''), context);
  const module = { exports: {} as Record<string, any> };
  const requireMock = (id: string) => {
    if (id === 'lit') return {
      LitElement: MockLitElement, css: noop,
      html: (strings: string[], ...values: unknown[]) => ({ strings, values }),
    };
    if (id === 'lit/decorators.js') return { customElement: () => (value: unknown) => value, property: () => noop };
    if (id.includes('i18n')) return { t: (value: string) => value };
    return {};
  };
  const compiled = ts.transpileModule(readFileSync(new URL('./controls.ts', import.meta.url), 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true, useDefineForClassFields: false,
    },
  }).outputText;
  runInContext(`(function(require,module,exports){${compiled}\n})`, context)(requireMock, module, module.exports);

  function slider(value: number, min: number, max: number, step: number) {
    const adapter = new module.exports.AppSlider();
    Object.assign(adapter, { value, min, max, step });
    const native = new Slider();
    Object.assign(native, {
      _value: '', $fastController: { isConnected: true }, elementInternals: {},
      direction: 'ltr', orientation: 'horizontal', valueTextFormatter: (text: string) => text,
      setSliderPosition: noop, setFormValue: noop, matches: () => false,
      $emit: (type: string) => adapter.onNativeChange({ type, stopPropagation: noop, currentTarget: native }),
      track: { clientWidth: 100, clientLeft: 0, getBoundingClientRect: () => ({ top: 0, bottom: 10 }) },
      thumb: { getBoundingClientRect: () => ({ width: 0 }) },
      getBoundingClientRect: () => ({ left: 0 }),
    });
    // FAST's number-like attribute converter and changed callbacks.
    for (const key of ['min', 'max', 'step']) {
      let stored = '';
      Object.defineProperty(native, key, {
        get: () => stored,
        set(next: unknown) {
          const text = String(next);
          if (text !== stored) { stored = text; native[`${key}Changed`](); }
        },
      });
    }
    adapter.renderRoot = { querySelector: () => native };
    function applyTemplateProperties() {
      const { strings, values } = adapter.render();
      strings.forEach((text: string, index: number) => {
        const property = /\.(value|min|max|step)=$/.exec(text)?.[1];
        if (property) native[property] = values[index];
      });
    }
    return {
      adapter, native,
      mount() {
        native.$fastController.isConnected = false;
        applyTemplateProperties();
        native.$fastController.isConnected = true;
        adapter.firstUpdated?.();
        native.updateStepMultiplier();
        native.setupDefaultValue(); // Fluent's first animation-frame callback.
      },
      update(changed: Map<string, number>) {
        applyTemplateProperties();
        adapter.updated?.(changed);
      },
    };
  }
  return { AppSelect: module.exports.AppSelect, Dropdown, slider };
}

describe('Fluent control synchronization', () => {
  it('selects numeric stored values while keeping change detail numeric', () => {
    const { AppSelect, Dropdown } = harness();
    const adapter = new AppSelect();
    const setValue = Object.getOwnPropertyDescriptor(Dropdown.prototype, 'value')!.set!;
    const native: any = {
      listbox: {}, enabledOptions: [{ value: '1' }, { value: '4' }, { value: '8' }],
      selectedIndex: -1, selectOption(index: number) { this.selectedIndex = index; },
    };
    Object.defineProperty(native, 'value', {
      set(value: unknown) { setValue.call(native, value); },
      get() { return native.enabledOptions[native.selectedIndex]?.value; },
    });
    adapter.options = [{ value: 1 }, { value: 4 }, { value: 8 }];
    adapter.renderRoot = { querySelector: () => native };
    adapter.value = 4;
    adapter.syncValue();
    expect(native.selectedIndex).toBe(1);
    expect(adapter.emitted).toEqual([]);
    native.selectedIndex = 2;
    adapter.onNativeChange({ stopPropagation: noop, currentTarget: native });
    expect(adapter.emitted).toEqual([{ type: 'change', detail: 8 }]);
  });

  it('keeps an out-of-range stored value when Fluent initializes its display', () => {
    const { adapter, native, mount } = harness().slider(4, 1.2, 3.2, 0.01);
    mount();
    expect(native.value).toBe('3.2');
    expect(adapter.value).toBe(4);
    expect(adapter.emitted).toEqual([]);
  });

  it('keeps exact numeric tuning through programmatic updates and range changes', () => {
    const { adapter, native, mount, update } = harness().slider(0.6, 0, 1, 0.05);
    mount();
    adapter.value = 0.63;
    update(new Map([['value', 0.6]]));
    expect(native.value).toBe('0.65');
    expect(adapter.value).toBe(0.63);
    adapter.min = 1.2; adapter.max = 3.2; adapter.step = 0.01; adapter.value = 2.23;
    update(new Map([['min', 0], ['max', 1], ['step', 0.05], ['value', 0.63]]));
    expect(native.value).toBe('2.23');
    expect(adapter.value).toBe(2.23);
    expect(adapter.emitted).toEqual([]);
  });

  it('preserves keyboard and pointer Fluent change events after synchronization', () => {
    const { adapter, native, mount, update } = harness().slider(0.6, 0, 1, 0.05);
    mount();
    native.handleKeydown({ key: 'ArrowRight', preventDefault: noop });
    expect(adapter.value).toBe(0.65);
    expect(adapter.emitted).toEqual([{ type: 'change', detail: 0.65 }]);
    // Real Fluent pointer handlers emit an untrusted CustomEvent, just like
    // keyboard/assistive input. Do not filter it using event.isTrusted.
    native.handlePointerDown({ pageX: 80 });
    expect(adapter.emitted.at(-1)).toEqual({ type: 'change', detail: 0.8 });
    update(new Map([['value', 0.65]]));
    expect(adapter.emitted).toHaveLength(2);
    native.handlePointerMove({ pageX: 85 });
    expect(adapter.emitted.at(-1)).toEqual({ type: 'change', detail: 0.85 });
    native.handleKeydown({ key: 'End', preventDefault: noop });
    expect(adapter.emitted.at(-1)).toEqual({ type: 'change', detail: 1 });
    native.handleKeydown({ key: 'Home', preventDefault: noop });
    expect(adapter.emitted.at(-1)).toEqual({ type: 'change', detail: 0 });
    adapter.disabled = true;
    native.value = '0.9';
    expect(adapter.value).toBe(0);
    expect(adapter.emitted).toHaveLength(5);
  });
});
