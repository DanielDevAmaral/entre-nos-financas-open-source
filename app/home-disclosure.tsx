"use client";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { HomeCardId } from "../src/domain/preferences";
export function HomeDisclosure({
  title,
  cardId,
  caption,
  initiallyOpen,
  children,
}: {
  title: string;
  cardId: HomeCardId;
  caption?: string;
  initiallyOpen: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const id = useId();
  useEffect(() => {
    const reveal = () => {
      if (cardId === "cards" && location.hash.startsWith("#card-"))
        setExpanded(true);
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [cardId]);
  return (
    <section className="family-card home-disclosure" data-expanded={expanded}>
      <h2 className="home-disclosure-heading">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((v) => !v)}
        >
          <span>
            {title}
            {caption && <small>{caption}</small>}
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
      <div id={id} className="home-disclosure-body" hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
