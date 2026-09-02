import NotamMap from "./notam-map";
import notamData from "../data/notams.json";

export default function Home() {
  const data = notamData as unknown as { notams?: unknown[] };
  const notams = Array.isArray(data.notams) ? data.notams : [];

  return <NotamMap notams={notams as any} />;
}
