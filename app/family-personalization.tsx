"use client";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { type HomeCardId, type Preferences } from "../src/domain/preferences";
export function HomeBlock({
  children,
}: {
  cardId: HomeCardId;
  caption?: string;
  children: ReactNode;
}) {
  return <>{children}</>;
}
export { HomeLayout } from "./home-editor";
async function request(path: string, body: unknown): Promise<Preferences> {
  const r = await fetch("/api/profile/" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Não foi possível salvar.");
  return data;
}
async function preparePhoto(file: File) {
  if (!file.type.startsWith("image/") || file.size > 12 * 1024 * 1024)
    throw new Error("Escolha uma foto de até 12 MB.");
  try {
    // data: images are permitted by the app CSP; blob: URLs deliberately are not.
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Não foi possível ler a foto."));
      reader.onload = () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Foto inválida."));
      reader.readAsDataURL(file);
    });
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error();
    const size = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 256, 256);
    ctx.drawImage(
      img,
      (img.naturalWidth - size) / 2,
      (img.naturalHeight - size) / 2,
      size,
      size,
      0,
      0,
      256,
      256,
    );
    return canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
  } catch {
    throw new Error(
      "Não foi possível abrir essa foto. Tente JPG, PNG ou WebP.",
    );
  }
}
export function PreferencesPanel({
  preferences,
  onSaved,
  name,
  onTour,
  onEditHome,
}: {
  preferences: Preferences;
  onSaved: (p: Preferences) => void;
  name: string;
  onTour: () => void;
  onEditHome: () => void;
}) {
  const [draft, setDraft] = useState(preferences),
    [photo, setPhoto] = useState<string | null | undefined>(),
    [busy, setBusy] = useState(false),
    [processing, setProcessing] = useState(false),
    [message, setMessage] = useState("");
  const photoSequence = useRef(0);
  const saving = useRef(false);
  useEffect(() => {
    setDraft((prior) => ({
      ...prior,
      accent: preferences.accent,
      theme: preferences.theme,
    }));
  }, [preferences.accent, preferences.theme]);
  useEffect(
    () => () => {
      photoSequence.current++;
    },
    [],
  );
  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving.current || processing) return;
    saving.current = true;
    setBusy(true);
    setMessage("");
    try {
      const p = await request("preferences", {
        revision: preferences.revision,
        accent: draft.accent,
        theme: draft.theme,
        ...(photo !== undefined ? { photo } : {}),
      });
      onSaved(p);
      setPhoto(undefined);
      setMessage("Seu espaço foi salvo na sua conta.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
      saving.current = false;
    }
  }
  async function savePhoto(value: string | null) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setPhoto(value);
    setMessage("");
    try {
      const p = await request("preferences", {
        revision: preferences.revision,
        photo: value,
      });
      onSaved(p);
      setPhoto(undefined);
      setMessage(
        value === null
          ? "Sua foto foi removida da conta."
          : "Foto salva na sua conta e atualizada no cabeçalho.",
      );
    } catch (error) {
      setMessage(
        (error instanceof Error
          ? error.message
          : "Não foi possível salvar a foto.") +
          " A alteração ainda não foi salva. Tente novamente em Salvar meu espaço.",
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const photoUrl = photo
    ? "data:image/jpeg;base64," + photo
    : photo === null
      ? null
      : preferences.has_photo
        ? "/api/profile/photo?v=" + preferences.revision
        : null;
  return (
    <section
      className="family-card personalization"
      aria-label="Minha personalização"
    >
      <h2>Do meu jeito</h2>
      <p className="fine">
        Olá, {name.split(" ")[0]}. Estas escolhas são só suas e acompanham sua
        conta em outros aparelhos. Os dados financeiros continuam compartilhados
        com a família.
      </p>
      <form onSubmit={save}>
        <fieldset disabled={busy}>
          <legend>Meu perfil e aparência</legend>
          <div className="personal-photo">
            {photoUrl ? (
              <img
                src={photoUrl}
                alt="Sua foto de perfil"
                width="64"
                height="64"
              />
            ) : (
              <span aria-hidden="true">{name.charAt(0)}</span>
            )}
            <label>
              Adicionar ou trocar foto
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const seq = ++photoSequence.current;
                  setProcessing(true);
                  setMessage("");
                  try {
                    const result = await preparePhoto(f);
                    if (seq === photoSequence.current) await savePhoto(result);
                  } catch (error) {
                    if (seq === photoSequence.current)
                      setMessage(
                        error instanceof Error
                          ? error.message
                          : "Foto inválida.",
                      );
                  } finally {
                    if (seq === photoSequence.current) setProcessing(false);
                  }
                }}
              />
            </label>
          </div>
          {photoUrl && (
            <button
              type="button"
              onClick={() => {
                photoSequence.current++;
                setProcessing(false);
                void savePhoto(null);
              }}
            >
              Remover minha foto
            </button>
          )}
          <p className="fine">
            A foto é salva ao escolher. Ela é reduzida antes do envio e seus
            metadados são removidos. Ela não tem link público.
          </p>
          <label>
            Cor de destaque
            <input
              type="color"
              value={draft.accent}
              onChange={(e) => setDraft({ ...draft, accent: e.target.value })}
            />
          </label>
          <div className="personal-swatches">
            {["#c5ab8b", "#8cb5a1", "#a9b7d7", "#c6a2bf", "#d6b178"].map(
              (color) => (
                <button
                  type="button"
                  key={color}
                  aria-label={"Escolher cor " + color}
                  aria-pressed={draft.accent === color}
                  style={{ background: color }}
                  onClick={() => setDraft({ ...draft, accent: color })}
                />
              ),
            )}
          </div>
          <label>
            Aparência
            <select
              value={draft.theme}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  theme: e.target.value as Preferences["theme"],
                })
              }
            >
              <option value="system">Do aparelho</option>
              <option value="light">Claro</option>
              <option value="dark">Escuro</option>
            </select>
          </label>
        </fieldset>
        <div className="personal-layout-link">
          <strong>Organização da tela principal</strong>
          <p className="fine">
            Edite os próprios cards, arrastando, usando setas ou tocando na
            lixeira. Remover da tela não apaga informações.
          </p>
          <button type="button" onClick={onEditHome}>
            Organizar minha tela principal
          </button>
        </div>
        <button className="primary" disabled={busy || processing}>
          {processing
            ? "Preparando foto…"
            : busy
              ? "Salvando…"
              : "Salvar meu espaço"}
        </button>
        {message && <p role="status">{message}</p>}
      </form>
      <button type="button" onClick={onTour}>
        Ver apresentação do app
      </button>
    </section>
  );
}
export { GuidedTour as AppOverview } from "./guided-tour";
