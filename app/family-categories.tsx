"use client";
import { useState } from "react";
export function CategoryIcon({ name }: { name: string }) {
  const n = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const path = /supermerc|feira|mercado/.test(n)
    ? "M3 3h2l3 12h10l3-9H6M9 20h.01M18 20h.01"
    : /alimenta|lanche|restaurante/.test(n)
      ? "M5 3v7m3-7v7M3 7h7m-4 3v11M17 3v18m0-18c-5 4-5 9 0 9"
      : /morad|casa|aluguel|financ/.test(n)
        ? "m3 11 9-8 9 8M5 10v11h14V10M10 21v-7h4v7"
        : /transpor|combust|uber/.test(n)
          ? "m5 7 2-4h10l2 4M3 8h18v10H3zM6 12h.01M18 12h.01M5 18v3m14-3v3"
          : /saude|farmac|medic/.test(n)
            ? "M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"
            : /educa|curso|escola/.test(n)
              ? "m2 8 10-5 10 5-10 5-10-5M6 10v7c4 3 8 3 12 0v-7m4-2v8"
              : /lazer|viag/.test(n)
                ? "M3 8h18v13H3zM8 8V4h8v4M8 8v13m8-13v13"
                : /telefone|internet|assinatura/.test(n)
                  ? "M8 3h8v18H8zM11 17h2"
                  : /tarifa|impost|taxa/.test(n)
                    ? "M5 3h14v18l-3-2-4 2-4-2-3 2zM8 7h8M8 11h8M8 15h4"
                    : /roupa|compra|vest/.test(n)
                      ? "m8 3-5 3 3 5 2-1v11h8V10l2 1 3-5-5-3c-2 3-6 3-8 0"
                      : "M3 7h18v14H3zM8 7V3h8v4M3 12h18";
  return (
    <svg
      className="category-svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
export function CategoryPicker({
  categories,
  value,
  required = false,
}: {
  categories: { id: string; name: string }[];
  value?: string | null;
  required?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded
    ? categories
    : categories.filter((c, i) => i < 8 || c.id === value);
  return (
    <fieldset className="category-picker">
      <legend>Categoria{required ? "" : " (opcional)"}</legend>
      <div className="category-grid">
        {!required && (
          <label className="category-choice">
            <input
              type="radio"
              name="category_id"
              value=""
              defaultChecked={!value}
            />
            <span>
              <CategoryIcon name="Sem categoria" />
              Sem categoria
            </span>
          </label>
        )}
        {shown.map((c) => (
          <label className="category-choice" key={c.id}>
            <input
              type="radio"
              name="category_id"
              value={c.id}
              required={required}
              defaultChecked={c.id === value}
            />
            <span>
              <CategoryIcon name={c.name} />
              {c.name}
            </span>
          </label>
        ))}
      </div>
      {!expanded && categories.length > 8 && (
        <button type="button" onClick={() => setExpanded(true)}>
          Ver todas as categorias
        </button>
      )}
    </fieldset>
  );
}
