// Text overlay editor: content, font, colours, outline/shadow/box/glow, size and animations. Edits apply live to the
// selected text (one undo step per sheet visit). Drag/pinch the text on the preview to place it.
import { useEffect, useRef } from 'react';
import { Sheet } from '../../app/ui/Sheet';
import { FONTS, FONT_IDS, loadFont } from '../overlay/fonts';
import { textsOf, updateText } from '../overlay/textOps';
import { useEditor } from '../store';
import type { TextAnimIn, TextAnimLoop, TextItem, TextStyle } from '../timeline/model';

const COLORS = ['#ffffff', '#000000', '#FFE14D', '#FF2D87', '#22d3ee', '#4ade80', '#fb923c', '#a78bfa'];
const ANIM_IN: Array<[TextAnimIn, string]> = [
  ['none', 'None'],
  ['pop', 'Pop'],
  ['typewriter', 'Type'],
  ['bounce', 'Bounce'],
  ['slide', 'Slide'],
  ['fade', 'Fade'],
];
const LOOPS: Array<[TextAnimLoop, string]> = [
  ['none', 'None'],
  ['bounce', 'Bounce'],
  ['pulse', 'Pulse'],
  ['wiggle', 'Wiggle'],
  ['glow', 'Glow'],
];

/** Quick looks: one tap sets several style fields. */
const LOOKS: Array<{ label: string; style: Partial<TextStyle> }> = [
  { label: 'Classic', style: { color: '#ffffff', outline: '#000000', shadow: true, box: null, glow: null } },
  { label: 'Boxed', style: { color: '#000000', outline: null, shadow: false, box: '#ffffff', glow: null } },
  { label: 'Pink box', style: { color: '#ffffff', outline: null, shadow: false, box: '#FF2D87', glow: null } },
  { label: 'Neon', style: { color: '#ffffff', outline: null, shadow: false, box: null, glow: '#FF2D87' } },
  { label: 'Yellow', style: { color: '#FFE14D', outline: '#000000', shadow: true, box: null, glow: null } },
];

function Chips<T extends string>({ value, options, onPick }: { value: T; options: Array<[T, string]>; onPick(v: T): void }) {
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onPick(v)}
          className={`min-h-9 shrink-0 rounded-full px-3 text-xs font-semibold ${value === v ? 'bg-zinc-100 text-black' : 'bg-zinc-800 text-zinc-300'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function TextSheet({ open, onClose, textId, focus }: { open: boolean; onClose(): void; textId: string | null; focus?: boolean }) {
  const item = useEditor((s) => (s.project && textId ? textsOf(s.project).find((t) => t.id === textId) : undefined));
  const input = useRef<HTMLTextAreaElement>(null);

  // All edits while the sheet is open form one undo step.
  useEffect(() => {
    if (!open) return;
    const editor = useEditor.getState();
    editor.beginGesture();
    for (const id of FONT_IDS) void loadFont(id);
    return () => useEditor.getState().endGesture();
  }, [open]);

  useEffect(() => {
    if (open && focus) {
      input.current?.focus();
      input.current?.select();
    }
  }, [open, focus]);

  if (!item) return null;
  const set = (patch: Partial<TextItem>) => useEditor.getState().apply((p) => updateText(p, item.id, patch));
  const style = (patch: Partial<TextStyle>) => set({ style: { ...item.style, ...patch } });

  return (
    <Sheet open={open} onClose={onClose} title="Text">
      <div className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto pb-1">
        <textarea
          ref={input}
          value={item.text}
          onChange={(e) => set({ text: e.target.value })}
          rows={2}
          aria-label="Text"
          className="w-full resize-none rounded-xl bg-zinc-800 px-3 py-2 text-base"
        />
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {FONT_IDS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => style({ font: id })}
              style={{ fontFamily: `"${FONTS[id].family}"`, fontWeight: FONTS[id].weight }}
              className={`min-h-10 shrink-0 rounded-xl px-3 text-sm ${item.style.font === id ? 'bg-zinc-100 text-black' : 'bg-zinc-800'}`}
            >
              {FONTS[id].label}
            </button>
          ))}
        </div>
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {LOOKS.map((l) => (
            <button
              key={l.label}
              type="button"
              onClick={() => style(l.style)}
              className="min-h-9 shrink-0 rounded-full bg-zinc-800 px-3 text-xs font-semibold"
            >
              {l.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              onClick={() => style({ color: c })}
              className={`size-8 shrink-0 rounded-full border-2 ${item.style.color === c ? 'border-pink-500' : 'border-zinc-700'}`}
              style={{ background: c }}
            />
          ))}
        </div>
        <div className="grid grid-cols-5 gap-1.5 text-xs font-semibold">
          {(
            [
              ['Outline', item.style.outline !== null, () => style({ outline: item.style.outline ? null : '#000000' })],
              ['Shadow', item.style.shadow, () => style({ shadow: !item.style.shadow })],
              ['Box', item.style.box !== null, () => style({ box: item.style.box ? null : '#000000b3' })],
              ['Glow', item.style.glow !== null, () => style({ glow: item.style.glow ? null : '#FF2D87' })],
              ['ABC', item.style.uppercase, () => style({ uppercase: !item.style.uppercase })],
            ] as const
          ).map(([label, on, toggle]) => (
            <button
              key={label}
              type="button"
              onClick={toggle}
              className={`min-h-10 rounded-xl ${on ? 'bg-pink-500' : 'bg-zinc-800 text-zinc-300'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-3 text-sm">
          <span className="w-10 text-zinc-400">Size</span>
          <input
            type="range"
            min={36}
            max={180}
            value={item.style.size}
            onChange={(e) => style({ size: Number(e.target.value) })}
            className="flex-1 accent-pink-500"
          />
        </label>
        <div>
          <div className="mb-1 text-xs text-zinc-400">In</div>
          <Chips value={item.animIn} options={ANIM_IN} onPick={(v) => set({ animIn: v })} />
          <div className="mb-1 mt-2 text-xs text-zinc-400">Out</div>
          <Chips value={item.animOut} options={ANIM_IN.filter(([v]) => v !== 'typewriter')} onPick={(v) => set({ animOut: v })} />
          <div className="mb-1 mt-2 text-xs text-zinc-400">Loop</div>
          <Chips value={item.loop} options={LOOPS} onPick={(v) => set({ loop: v })} />
        </div>
        <button type="button" onClick={onClose} className="min-h-12 rounded-xl bg-pink-500 font-bold">
          Done
        </button>
      </div>
    </Sheet>
  );
}
