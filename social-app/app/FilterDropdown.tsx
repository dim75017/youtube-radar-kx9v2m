"use client";

import { useEffect, useRef, useState } from "react";

export type FilterDropdownOption<Key extends string> = {
  key: Key;
  emoji: string;
  label: string;
  count?: number;
};

function formatFilterCount(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

export function FilterDropdown<Key extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: Key;
  options: readonly FilterDropdownOption<Key>[];
  onChange: (value: Key) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.key === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!selected) return null;
  const listboxId = `${id}-options`;

  return (
    <div className={`top-filter-dropdown ${open ? "is-open" : ""}`} ref={containerRef}>
      <span className="section-kicker">{label}</span>
      <button
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${label} : ${selected.label}`}
        className="top-filter-dropdown-trigger"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const focusLast = event.key === "ArrowUp";
          event.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => {
            const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
            items?.[focusLast ? items.length - 1 : 0]?.focus();
          });
        }}
        ref={triggerRef}
        type="button"
      >
        <span className="top-filter-dropdown-value">
          <span aria-hidden="true">{selected.emoji}</span>
          <span>{selected.label}</span>
          {selected.count !== undefined ? (
            <span className="top-filter-dropdown-count">{formatFilterCount(selected.count)}</span>
          ) : null}
        </span>
        <span aria-hidden="true" className="top-filter-dropdown-caret">⌄</span>
      </button>

      {open ? (
        <div
          aria-label={label}
          className="top-filter-dropdown-menu"
          id={listboxId}
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
            );
            if (!items.length) return;
            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
            let nextIndex = currentIndex;
            if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
            else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
            else if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = items.length - 1;
            else return;
            event.preventDefault();
            items[nextIndex]?.focus();
          }}
          ref={menuRef}
          role="listbox"
        >
          {options.map((option) => (
            <button
              aria-selected={option.key === value}
              className={option.key === value ? "active" : ""}
              key={option.key}
              onClick={() => {
                onChange(option.key);
                setOpen(false);
                triggerRef.current?.focus();
              }}
              role="option"
              type="button"
            >
              <span aria-hidden="true">{option.emoji}</span>
              <span>{option.label}</span>
              {option.count !== undefined ? (
                <span className="top-filter-dropdown-count">{formatFilterCount(option.count)}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
