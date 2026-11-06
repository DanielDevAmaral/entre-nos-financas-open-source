"use client";
import { useId, type ReactNode } from "react";

export function ProfileCard({
  title,
  description,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  description: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="profile-card" data-expanded={expanded}>
      <h2 className="profile-card-title">
        <button
          type="button"
          id={id + "-title"}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={onToggle}
        >
          <span>
            <strong>{title}</strong>
            <small>{description}</small>
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </h2>
      <div
        className="profile-card-body"
        id={id}
        role="region"
        aria-labelledby={id + "-title"}
        hidden={!expanded}
      >
        {children}
      </div>
    </section>
  );
}
