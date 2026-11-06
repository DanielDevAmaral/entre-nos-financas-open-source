"use client";
import { useEffect, useId, useRef, useState } from "react";

export function QuickActions({
  planning,
  reader,
  onIncome,
  onExpense,
  onEdit,
}: {
  planning: boolean;
  reader: boolean;
  onIncome: () => void;
  onExpense: () => void;
  onEdit: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const id = useId();
  function close() {
    setExpanded(false);
    trigger.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (!expanded) return;
    // Keyboard users enter the action list immediately; readers can still edit their layout.
    first.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpanded(false);
        trigger.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [expanded]);
  const actions = [
    {
      label: planning ? "Planejar Entrada" : "Adicionar Entrada",
      run: onIncome,
      icon: "income",
      disabled: reader,
    },
    {
      label: planning ? "Planejar Gastos" : "Registrar Gasto",
      run: onExpense,
      icon: "expense",
      disabled: reader,
    },
    { label: "Editar tela", run: onEdit, icon: "edit", disabled: false },
  ];
  return (
    <>
      {expanded && (
        <button
          type="button"
          className="quick-actions-backdrop"
          aria-label="Fechar ações rápidas"
          onClick={close}
          tabIndex={-1}
        />
      )}
      <div className="family-quick-actions" data-open={expanded}>
        <div
          id={id}
          className="quick-actions-list"
          role="group"
          aria-label="Ações do mês"
          aria-hidden={!expanded}
          inert={!expanded}
        >
          {actions.map((action, index) => (
            <button
              key={action.icon}
              type="button"
              ref={
                reader
                  ? index === 2
                    ? first
                    : undefined
                  : index === 0
                    ? first
                    : undefined
              }
              disabled={action.disabled}
              className="quick-action"
              onClick={() => {
                setExpanded(false);
                action.run();
              }}
            >
              <span className="quick-action-circle" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {action.icon === "edit" ? (
                    <>
                      <path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z" />
                    </>
                  ) : (
                    <>
                      <path
                        d={
                          action.icon === "income"
                            ? "M12 4v16m-6-6 6 6 6-6"
                            : "M12 20V4m-6 6 6-6 6 6"
                        }
                      />
                    </>
                  )}
                </svg>
              </span>
              <span className="quick-action-label">{action.label}</span>
            </button>
          ))}
        </div>
        <button
          ref={trigger}
          data-tour="quick-actions"
          className="quick-actions-trigger"
          type="button"
          aria-label={expanded ? "Fechar ações" : "Abrir ações"}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => (expanded ? close() : setExpanded(true))}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
    </>
  );
}
