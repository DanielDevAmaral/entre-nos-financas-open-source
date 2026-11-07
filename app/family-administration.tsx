"use client";
import { useState } from "react";
import { useAsyncAction } from "./use-async-action";
type Family = {
  id: string;
  name: string;
  people: { name: string; email: string }[];
};
async function request(body?: unknown) {
  const r = await fetch("/api/admin/families", {
    method: body ? "POST" : "GET",
    cache: "no-store",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || "Não foi possível concluir.");
  return result;
}
export function FamilyAdministration() {
  const [families, setFamilies] = useState<Family[] | null>(null),
    [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const { busy, error, notice, run } = useAsyncAction();
  return (
    <section
      className="family-card family-administration"
      aria-label="Administração de famílias"
    >
      <h2>Famílias que você administra</h2>
      <p className="fine">
        Só seu perfil pode liberar novos casais. Cada casal terá seu próprio
        espaço, separado das finanças de vocês. Até 30 pessoas no total.
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setFamilies((await request()).families);
          })
        }
      >
        Ver famílias cadastradas
      </button>
      {families?.map((f) => (
        <div key={f.id}>
          <h3>{f.name}</h3>
          {f.people.map((p) => (
            <p key={p.email}>
              {p.name}
              <br />
              <small>{p.email}</small>
            </p>
          ))}
        </div>
      ))}
      {families?.length === 0 && <p>Nenhum outro casal cadastrado ainda.</p>}
      <details>
        <summary>Adicionar um casal</summary>
        <form
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              v = new FormData(form);
            void run(
              async () => {
                await request({
                  request_id: requestId,
                  familyName: v.get("familyName"),
                  currentPassword: v.get("currentPassword"),
                  first: {
                    name: v.get("firstName"),
                    email: v.get("firstEmail"),
                    password: v.get("firstPassword"),
                  },
                  second: {
                    name: v.get("secondName"),
                    email: v.get("secondEmail"),
                    password: v.get("secondPassword"),
                  },
                });
                form.reset();
                setRequestId(crypto.randomUUID());
                setFamilies((await request()).families);
              },
              "Casal cadastrado. Cada pessoa já pode entrar com seu e-mail e sua senha. Oriente a trocar a senha inicial no próprio perfil.",
            );
          }}
        >
          <label>
            Nome da família
            <input name="familyName" required maxLength={120} />
          </label>
          {(["first", "second"] as const).map((prefix, i) => (
            <fieldset key={prefix}>
              <legend>{i === 0 ? "Primeira pessoa" : "Segunda pessoa"}</legend>
              <label>
                Nome
                <input
                  name={prefix + "Name"}
                  required
                  maxLength={120}
                  autoComplete="off"
                />
              </label>
              <label>
                E-mail
                <input
                  name={prefix + "Email"}
                  type="email"
                  required
                  maxLength={200}
                  autoComplete="off"
                />
              </label>
              <label>
                Senha inicial
                <input
                  name={prefix + "Password"}
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                />
              </label>
            </fieldset>
          ))}
          <label>
            Sua senha para autorizar
            <input
              name="currentPassword"
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="current-password"
            />
          </label>
          <p className="fine">
            Os dois acessos são criados juntos. As senhas não ficam visíveis na
            lista de famílias. Entregue cada acesso à pessoa correspondente por
            um canal privado.
          </p>
          <button disabled={busy}>
            {busy
              ? "Criando acessos…"
              : "Criar família e liberar os dois acessos"}
          </button>
        </form>
      </details>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
