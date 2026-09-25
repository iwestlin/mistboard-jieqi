// Tiny DOM helpers. No framework: this app is a handful of screens.

type Child = Node | string | null | undefined | false;

export type Props = {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  id?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: any) => void>>;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.html !== undefined) el.innerHTML = props.html;
  if (props.title) el.title = props.title;
  if (props.id) el.id = props.id;
  for (const [key, value] of Object.entries(props.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const [event, handler] of Object.entries(props.on ?? {})) {
    if (handler) el.addEventListener(event, handler as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function clear(el: HTMLElement): HTMLElement {
  el.replaceChildren();
  return el;
}

export function button(label: string, onClick: () => void, opts: { class?: string; title?: string; disabled?: boolean } = {}) {
  return h('button', {
    class: ['btn', opts.class].filter(Boolean).join(' '),
    text: label,
    title: opts.title,
    attrs: { type: 'button', disabled: opts.disabled ?? false },
    on: { click: onClick },
  });
}

export function select<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T,
  onChange: (value: T) => void,
): HTMLSelectElement {
  const el = h('select', { class: 'select' });
  for (const option of options) {
    el.append(
      h('option', { text: option.label, attrs: { value: option.value, selected: option.value === value } }),
    );
  }
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}
