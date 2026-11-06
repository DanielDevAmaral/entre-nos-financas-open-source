import { connection } from "next/server";
import Family from "./family";
export default async function Page() {
  await connection();
  return <Family />;
}
