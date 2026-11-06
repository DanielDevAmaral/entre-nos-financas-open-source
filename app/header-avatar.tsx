"use client";
import { useState } from "react";
import { FamilyIcon } from "./family-extras";
export function HeaderAvatar({
  hasPhoto,
  revision,
}: {
  hasPhoto: boolean;
  revision: number;
}) {
  const [failed, setFailed] = useState(false);
  return hasPhoto && !failed ? (
    <img
      className="personal-avatar"
      src={"/api/profile/photo?v=" + revision}
      alt="Minha foto de perfil"
      width="36"
      height="36"
      decoding="async"
      onError={() => setFailed(true)}
    />
  ) : (
    <FamilyIcon name="us" />
  );
}
