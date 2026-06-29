"use client";

import {
  IconCheck,
  IconClipboardList,
  IconGripVertical,
  IconInfoCircle,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useState } from "react";
import type { ScreeningQuestion } from "@/lib/jobs";

const MAX_Q = 10;
const MAX_CHARS = 200;

type QType = ScreeningQuestion["type"];

const TYPE_META: Record<QType, { label: string; cls: string }> = {
  yesno: { label: "Yes / No", cls: "bg-[#EEEDFE] text-remotiv-purple" },
  numeric: { label: "Numeric", cls: "bg-[#E1F5EE] text-[#0F6E56]" },
  multiple: { label: "Multiple choice", cls: "bg-[#FBF0D9] text-[#92660a]" },
};

const QB_LABEL = "mb-1.5 block text-[12.5px] font-semibold text-[#6a6478]";
const QB_INPUT =
  "w-full rounded-[10px] border-[1.5px] border-[#e3ddd5] bg-white px-3.5 py-2.5 text-[13.5px] text-[#241F38] outline-none transition focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/15";
const QB_SELECT =
  "w-full cursor-pointer appearance-none rounded-[10px] border-[1.5px] border-[#e3ddd5] bg-white py-2.5 pl-3.5 pr-9 text-[13.5px] font-medium text-[#241F38] outline-none transition focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/15";

function blankQuestion(type: QType = "yesno"): ScreeningQuestion {
  const base = { id: crypto.randomUUID(), question: "", type, essential: false };
  if (type === "yesno") return { ...base, ideal: "Yes", options: [] };
  if (type === "numeric") return { ...base, ideal: "", options: [] };
  return { ...base, ideal: "0", options: ["", ""] };
}

// One-click starter questions. Each chip appends a fully editable/removable
// question (fresh id per click). No essential preset; ideals are valid
// type-defaults the admin can change.
const SUGGESTIONS: { label: string; template: Omit<ScreeningQuestion, "id"> }[] = [
  {
    label: "English proficiency",
    template: {
      question: "What is your level of proficiency in English?",
      type: "multiple",
      options: ["None", "Conversational", "Professional", "Native or bilingual"],
      ideal: "0",
      essential: false,
    },
  },
  {
    label: "Current salary",
    template: {
      question: "What is your current monthly salary? (PKR/USD)",
      type: "numeric",
      options: [],
      ideal: "0",
      essential: false,
    },
  },
  {
    label: "Salary expectations",
    template: {
      question: "What are your salary expectations? (PKR/USD)",
      type: "numeric",
      options: [],
      ideal: "0",
      essential: false,
    },
  },
  {
    label: "Immediate start",
    template: {
      question: "We must fill this position urgently. Can you start immediately?",
      type: "yesno",
      options: [],
      ideal: "Yes",
      essential: false,
    },
  },
];

// Patch produced when the response type changes — resets ideal/options to the
// new type's defaults (keeps existing options if there are already >= 2).
function retypePatch(type: QType, q: ScreeningQuestion): Partial<ScreeningQuestion> {
  if (type === q.type) return {};
  if (type === "yesno") return { type, ideal: "Yes", options: [] };
  if (type === "numeric") return { type, ideal: "", options: [] };
  return { type, ideal: "0", options: q.options.length >= 2 ? q.options : ["", ""] };
}

function SelectChevron() {
  return (
    <span className="pointer-events-none absolute right-[13px] top-1/2 size-2 -translate-y-[70%] rotate-45 border-b-2 border-r-2 border-[#9a9488]" />
  );
}

function Pill({ type }: { type: QType }) {
  const m = TYPE_META[type];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-[11px] py-[5px] text-[11px] font-bold uppercase tracking-[0.5px] ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function EssentialToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-1.5 pb-2.5">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={on}
        className="flex select-none items-center gap-2 text-[13px] font-semibold text-[#3a3550]"
      >
        <span
          className={`flex size-5 items-center justify-center rounded-[6px] border-2 text-white transition ${
            on ? "border-remotiv-green bg-remotiv-green" : "border-[#cfc9bf]"
          }`}
        >
          {on && <IconCheck size={13} stroke={3} />}
        </span>
        Essential
      </button>
      <span className="group relative inline-flex cursor-help text-[#bcb6a8]">
        <IconInfoCircle size={16} />
        <span className="invisible absolute bottom-[calc(100%+9px)] right-[-8px] z-20 w-[240px] rounded-[10px] bg-[#241f38] px-3 py-2.5 text-[11.5px] font-medium normal-case leading-[1.5] tracking-normal text-white opacity-0 shadow-[0_10px_30px_rgba(0,0,0,0.22)] transition group-hover:visible group-hover:opacity-100">
          If a candidate doesn&rsquo;t meet an Essential question, they&rsquo;ll
          see a warning but can still submit — the application is flagged for you.
        </span>
      </span>
    </div>
  );
}

function IdealAnswer({
  q,
  patch,
}: {
  q: ScreeningQuestion;
  patch: (p: Partial<ScreeningQuestion>) => void;
}) {
  if (q.type === "yesno") {
    return (
      <div className="min-w-[140px] flex-1">
        <span className={QB_LABEL}>Ideal answer</span>
        <div className="relative">
          <select
            className={QB_SELECT}
            value={q.ideal}
            onChange={(e) => patch({ ideal: e.target.value })}
          >
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
          <SelectChevron />
        </div>
      </div>
    );
  }
  if (q.type === "numeric") {
    return (
      <div className="min-w-[140px] flex-1">
        <span className={QB_LABEL}>Ideal answer (minimum)</span>
        <input
          className={QB_INPUT}
          type="number"
          min="0"
          value={q.ideal}
          placeholder="e.g. 3"
          onChange={(e) => patch({ ideal: e.target.value })}
        />
      </div>
    );
  }
  return null;
}

function MultipleChoice({
  q,
  patch,
}: {
  q: ScreeningQuestion;
  patch: (p: Partial<ScreeningQuestion>) => void;
}) {
  const idealIdx = Number.parseInt(q.ideal, 10) || 0;

  const setOption = (i: number, val: string) => {
    const options = q.options.slice();
    options[i] = val;
    patch({ options });
  };
  const removeOption = (i: number) => {
    if (q.options.length <= 2) return;
    const options = q.options.filter((_, idx) => idx !== i);
    let ideal = idealIdx;
    if (i === ideal) ideal = 0;
    else if (i < ideal) ideal = ideal - 1;
    patch({ options, ideal: String(ideal) });
  };
  const addOption = () => patch({ options: [...q.options, ""] });

  return (
    <div className="mt-4">
      <span className={QB_LABEL}>
        Options{" "}
        <span className="font-normal text-[#b3ad9f]">
          — tap the circle to set the ideal answer
        </span>
      </span>
      <div className="flex flex-col gap-2">
        {q.options.map((opt, i) => {
          const isIdeal = i === idealIdx;
          const atMin = q.options.length <= 2;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: option rows are positional, identity is the index
              key={i}
              className={`flex items-center gap-2.5 rounded-[9px] border px-3 py-1.5 transition ${
                isIdeal ? "border-[#bfe9d8] bg-[#f1fbf7]" : "border-[#efeae3] bg-[#faf8f5]"
              }`}
            >
              <button
                type="button"
                title="Set as ideal answer"
                aria-label={`Set option ${i + 1} as ideal answer`}
                onClick={() => patch({ ideal: String(i) })}
                className={`size-4 shrink-0 rounded-full border-2 transition ${
                  isIdeal
                    ? "border-remotiv-green bg-remotiv-green shadow-[inset_0_0_0_3px_#fff]"
                    : "border-[#cfc9bf] hover:border-remotiv-green"
                }`}
              />
              <input
                className={`flex-1 border-none bg-transparent py-[5px] text-[13px] outline-none ${
                  isIdeal ? "font-semibold text-[#0a4a3a]" : "text-[#3a3550]"
                }`}
                value={opt}
                placeholder={`Option ${i + 1}`}
                onChange={(e) => setOption(i, e.target.value)}
              />
              {isIdeal ? (
                <span className="text-[10.5px] font-bold uppercase tracking-[0.5px] text-[#1D9E75]">
                  Ideal
                </span>
              ) : (
                <button
                  type="button"
                  title={atMin ? "At least 2 options" : "Remove option"}
                  aria-label="Remove option"
                  disabled={atMin}
                  onClick={() => removeOption(i)}
                  className="text-[#cfc9bf] transition hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-[#cfc9bf]"
                >
                  <IconX size={15} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={addOption}
        className="mt-2.5 inline-flex items-center gap-1.5 rounded-[9px] border border-dashed border-[#cfc9bf] px-3.5 py-2 text-[12.5px] font-semibold text-remotiv-purple transition hover:border-remotiv-purple hover:bg-[#faf8ff]"
      >
        <IconPlus size={14} /> Add option
      </button>
    </div>
  );
}

type DragApi = {
  draggingId: string | null;
  overId: string | null;
  arm: (id: string) => void;
  onOver: (id: string) => void;
  onDrop: (id: string) => void;
  onEnd: () => void;
};

function QuestionCard({
  q,
  index,
  patch,
  remove,
  drag,
}: {
  q: ScreeningQuestion;
  index: number;
  patch: (p: Partial<ScreeningQuestion>) => void;
  remove: () => void;
  drag: DragApi;
}) {
  const isOver = drag.overId === q.id;
  const isDragging = drag.draggingId === q.id;
  return (
    <div
      draggable={isDragging}
      onDragOver={(e) => {
        e.preventDefault();
        drag.onOver(q.id);
      }}
      onDrop={(e) => {
        e.preventDefault();
        drag.onDrop(q.id);
      }}
      onDragEnd={drag.onEnd}
      className={`relative rounded-2xl border bg-white p-[18px] transition ${
        isOver ? "border-remotiv-purple ring-[3px] ring-remotiv-purple/15" : "border-[#ece6df]"
      } ${isDragging ? "opacity-55" : "hover:shadow-[0_4px_18px_rgba(0,0,0,0.05)]"}`}
    >
      <div className="mb-[13px] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span
            title="Drag to reorder"
            onMouseDown={() => drag.arm(q.id)}
            className="cursor-grab text-[#cfc9bf] active:cursor-grabbing"
          >
            <IconGripVertical size={18} />
          </span>
          <span className="flex size-[26px] items-center justify-center rounded-[8px] bg-[#EEEDFE] font-heading text-[13px] font-bold text-remotiv-purple">
            {index + 1}
          </span>
          <Pill type={q.type} />
        </div>
        <button
          type="button"
          title="Remove question"
          aria-label="Remove question"
          onClick={remove}
          className="flex size-[30px] items-center justify-center rounded-[8px] border border-[#ece6df] bg-white text-[#9a9488] transition hover:border-[#f3c9c9] hover:bg-[#fef5f5] hover:text-red-600"
        >
          <IconTrash size={16} />
        </button>
      </div>

      <span className={QB_LABEL}>
        Question <span className="text-red-600">*</span>
      </span>
      <div className="relative mb-[26px]">
        <textarea
          rows={2}
          maxLength={MAX_CHARS}
          value={q.question}
          placeholder="e.g. Are you authorized to work as a remote contractor?"
          onChange={(e) => patch({ question: e.target.value })}
          className={`${QB_INPUT} min-h-[46px] resize-y leading-[1.5]`}
        />
        <span
          className={`absolute -bottom-[18px] right-3 text-[11px] ${
            q.question.length >= MAX_CHARS ? "text-red-600" : "text-[#b3ad9f]"
          }`}
        >
          {q.question.length} / {MAX_CHARS}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3.5">
        <div className="min-w-[140px] flex-1">
          <span className={QB_LABEL}>Response type</span>
          <div className="relative">
            <select
              className={QB_SELECT}
              value={q.type}
              onChange={(e) => patch(retypePatch(e.target.value as QType, q))}
            >
              <option value="yesno">Yes / No</option>
              <option value="numeric">Numeric</option>
              <option value="multiple">Multiple choice</option>
            </select>
            <SelectChevron />
          </div>
        </div>
        <IdealAnswer q={q} patch={patch} />
        <EssentialToggle on={q.essential} onToggle={() => patch({ essential: !q.essential })} />
      </div>

      {q.type === "numeric" && q.ideal !== "" && (
        <p className="mt-2.5 rounded-[8px] bg-[#faf8f3] px-[11px] py-2 text-[11.5px] text-[#9a8f80]">
          <IconInfoCircle size={13} className="mr-1 inline align-[-1px]" />A
          candidate&rsquo;s answer counts as a match if it&rsquo;s{" "}
          <b className="text-[#3a3550]">{q.ideal} or more</b>.
        </p>
      )}

      {q.type === "multiple" && <MultipleChoice q={q} patch={patch} />}
    </div>
  );
}

export function ScreeningQuestionBuilder({
  value,
  onChange,
}: {
  value: ScreeningQuestion[];
  onChange: (q: ScreeningQuestion[]) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const patch = (id: string, p: Partial<ScreeningQuestion>) =>
    onChange(value.map((q) => (q.id === id ? { ...q, ...p } : q)));
  const remove = (id: string) => onChange(value.filter((q) => q.id !== id));
  const add = () => {
    if (value.length < MAX_Q) onChange([...value, blankQuestion("yesno")]);
  };
  const addSuggestion = (template: Omit<ScreeningQuestion, "id">) => {
    if (value.length >= MAX_Q) return;
    onChange([
      ...value,
      { ...template, id: crypto.randomUUID(), options: [...template.options] },
    ]);
  };
  const atCap = value.length >= MAX_Q;

  const drag: DragApi = {
    draggingId,
    overId,
    arm: (id) => setDraggingId(id),
    onOver: (id) => {
      if (draggingId && id !== overId) setOverId(id);
    },
    onDrop: (targetId) => {
      const from = value.findIndex((q) => q.id === draggingId);
      const to = value.findIndex((q) => q.id === targetId);
      if (from < 0 || to < 0 || from === to) return;
      const next = value.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      onChange(next);
    },
    onEnd: () => {
      setDraggingId(null);
      setOverId(null);
    },
  };

  const left = MAX_Q - value.length;

  return (
    <div className="pt-2">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="inline-block h-[22px] w-[5px] rounded-[3px] bg-remotiv-purple" />
          <h2 className="font-heading text-[18px] font-bold text-[#241f38]">
            Screening questions
          </h2>
        </div>
        <span className="rounded-full bg-[#f1ede6] px-[11px] py-[5px] text-[11px] font-bold uppercase tracking-[0.5px] text-[#8a8478]">
          {value.length} of {MAX_Q}
        </span>
      </div>
      <p className="mb-3 ml-[15px] text-[13px] text-[#9a9488]">
        Add up to 10 questions candidates must answer before applying. Mark
        must-haves as <b className="text-[#1D9E75]">Essential</b>.
      </p>

      <div className="mb-[18px] flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-[#9a9488]">Quick add:</span>
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={atCap}
            onClick={() => addSuggestion(s.template)}
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[#c9bffb] bg-white px-3 py-1.5 text-[12px] font-semibold text-remotiv-purple transition hover:border-remotiv-purple hover:bg-[#faf8ff] disabled:cursor-not-allowed disabled:border-[#e3ddd5] disabled:text-[#bcb6a8] disabled:hover:bg-white"
          >
            <IconPlus size={13} /> {s.label}
          </button>
        ))}
      </div>

      {value.length === 0 ? (
        <div className="rounded-2xl border-[1.5px] border-dashed border-[#d8d2c8] bg-[#fdfcfa] px-6 py-[34px] text-center">
          <div className="mx-auto mb-3.5 flex size-[54px] items-center justify-center rounded-[14px] bg-[#EEEDFE] text-remotiv-purple">
            <IconClipboardList size={26} />
          </div>
          <div className="mb-1.5 font-heading text-[16px] font-bold text-[#241f38]">
            No screening questions yet
          </div>
          <div className="mx-auto mb-[18px] max-w-[380px] text-[13px] leading-[1.55] text-[#9a9488]">
            Ask candidates what matters most — work authorization, years of
            experience, English level — before they apply.
          </div>
          <button
            type="button"
            onClick={add}
            className="inline-flex items-center gap-[7px] rounded-xl bg-remotiv-purple px-5 py-[11px] font-heading text-[13.5px] font-semibold text-white transition hover:bg-[#6a37ec]"
          >
            <IconPlus size={17} /> Add your first question
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-[14px]">
          {value.map((q, i) => (
            <QuestionCard
              key={q.id}
              q={q}
              index={i}
              patch={(p) => patch(q.id, p)}
              remove={() => remove(q.id)}
              drag={drag}
            />
          ))}
        </div>
      )}

      {value.length > 0 && (
        <button
          type="button"
          disabled={left === 0}
          onClick={add}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-[13px] border-[1.5px] border-dashed border-[#c9bffb] bg-white p-3.5 font-heading text-[14px] font-semibold text-remotiv-purple transition hover:border-remotiv-purple hover:bg-[#faf8ff] disabled:cursor-not-allowed disabled:border-[#e3ddd5] disabled:text-[#bcb6a8]"
        >
          <IconPlus size={18} />
          {left === 0 ? (
            "Maximum of 10 questions reached"
          ) : (
            <>
              Add question <span className="font-normal text-[#b3ad9f]">({left} left)</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}
