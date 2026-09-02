"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import { Circle as CircleGeom, LineString, Polygon } from "ol/geom";
import { fromLonLat } from "ol/proj";
import Style from "ol/style/Style";
import Stroke from "ol/style/Stroke";
import Fill from "ol/style/Fill";
import CircleStyle from "ol/style/Circle";
import "ol/ol.css";

type Geometry = {
  type?: string;
  center?: [number, number];
  radiusMeters?: number;
  radius?: number;
  radiusUnit?: string;
  coordinates?: Array<[number, number]> | Array<Array<[number, number]>>;
};

type Notam = {
  id: string;
  location?: string;
  rawText: string;
  lowerLimit?: string;
  upperLimit?: string;
  matchedTerms?: string[];
  effectiveFrom?: string;
  effectiveTo?: string;
  qCode?: string;
  geometries?: Geometry[];
};

function createCirclePoints(
  center: [number, number],
  radiusMeters: number,
  segments = 32,
): Array<[number, number]> {
  const [lon, lat] = center;
  const earthRadius = 6371000;
  const points: Array<[number, number]> = [];

  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const deltaLat = (radiusMeters * Math.cos(angle)) / earthRadius;
    const deltaLon =
      (radiusMeters * Math.sin(angle)) /
      (earthRadius * Math.cos((lat * Math.PI) / 180));

    points.push([
      lon + (deltaLon * 180) / Math.PI,
      lat + (deltaLat * 180) / Math.PI,
    ]);
  }

  return points;
}

function getMapGeometry(notam: Notam) {
  const firstGeometry = notam.geometries?.[0];
  if (!firstGeometry) return null;

  if (firstGeometry.type === "Circle" && firstGeometry.center) {
    const rad = firstGeometry.radiusMeters ?? firstGeometry.radius ?? 0;
    const circlePoints = createCirclePoints(firstGeometry.center, rad);
    const projectedPoints = circlePoints.map((point) => fromLonLat(point));
    return new Polygon([projectedPoints]);
  }

  if (firstGeometry.type === "Polygon" && firstGeometry.coordinates) {
    const coords = firstGeometry.coordinates as Array<Array<[number, number]>>;
    const projectedCoords = coords.map((ring) =>
      ring.map((point) => fromLonLat(point)),
    );
    return new Polygon(projectedCoords);
  }

  if (firstGeometry.type === "LineString" && firstGeometry.coordinates) {
    const coords = firstGeometry.coordinates as Array<[number, number]>;
    const projectedCoords = coords.map((point) => fromLonLat(point));
    return new LineString(projectedCoords);
  }

  return null;
}

export default function NotamMap({ notams }: { notams: Notam[] }) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const vectorSource = useRef<VectorSource>(new VectorSource());
  const [selectedId, setSelectedId] = useState<string | null>(
    notams[0]?.id ?? null,
  );

  const selectedNotam = useMemo(
    () => notams.find((notam) => notam.id === selectedId) ?? notams[0],
    [notams, selectedId],
  );

  // Populate vector source with features
  useEffect(() => {
    vectorSource.current.clear();

    notams.forEach((notam) => {
      const geometry = getMapGeometry(notam);
      if (!geometry) return;

      const feature = new Feature({
        geometry,
        id: notam.id,
        title: notam.location ?? notam.id,
        matchedTerms: notam.matchedTerms ?? [],
        notam: notam,
      });

      vectorSource.current.addFeature(feature);
    });

    // Fit map to features if available and map is initialized
    if (map.current && vectorSource.current.getFeatures().length > 0) {
      const extent = vectorSource.current.getExtent();
      if (extent) {
        map.current.getView().fit(extent, { padding: [50, 50, 50, 50] });
      }
    }
  }, [notams]);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const vectorLayer = new VectorLayer({
      source: vectorSource.current,
      style: (feature) => {
        const isSelected = feature.get("id") === selectedId;
        const isLineString = feature.getGeometry()?.getType() === "LineString";

        if (isLineString) {
          return new Style({
            stroke: new Stroke({
              color: isSelected ? "#ff0000" : "#ff4400",
              width: isSelected ? 6 : 3,
            }),
          });
        }

        return new Style({
          fill: new Fill({
            color: isSelected
              ? "rgba(255, 38, 0, 0.9)"
              : "rgba(255, 111, 0, 0.6)",
          }),
          stroke: new Stroke({
            color: isSelected ? "#ff0000" : "#ff4400",
            width: isSelected ? 5 : 3,
          }),
          image: new CircleStyle({
            radius: isSelected ? 10 : 7,
            fill: new Fill({
              color: isSelected ? "#ff0000" : "#ff4400",
            }),
            stroke: new Stroke({
              color: isSelected ? "#ff0000" : "#ff4400",
              width: isSelected ? 3 : 2,
            }),
          }),
        });
      },
    });

    const osmLayer = new TileLayer({
      source: new OSM(),
    });

    map.current = new Map({
      target: mapContainer.current,
      layers: [osmLayer, vectorLayer],
      view: new View({
        center: fromLonLat([-2.5, 54.5]),
        zoom: 6,
      }),
    });

    // Handle feature clicks
    map.current.on("click", (evt) => {
      map.current?.forEachFeatureAtPixel(evt.pixel, (feature) => {
        setSelectedId(feature.get("id") as string);
      });
    });

    // Change cursor on hover
    map.current.on("pointermove", (evt) => {
      const hasFeature = map.current?.hasFeatureAtPixel(evt.pixel);
      if (mapContainer.current) {
        mapContainer.current.style.cursor = hasFeature ? "pointer" : "";
      }
    });

    return () => {
      if (map.current) {
        map.current.setTarget(undefined);
        map.current = null;
      }
    };
  }, []);

  // Update style when selection changes
  useEffect(() => {
    if (!map.current) return;
    const vectorLayer = map.current
      .getLayers()
      .item(1) as VectorLayer<VectorSource>;
    if (vectorLayer) {
      vectorLayer.changed();
    }
  }, [selectedId]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <header className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-cyan-300">
              NOTAM intelligence
            </p>
            <h1 className="mt-2 text-3xl font-semibold">Landing area map</h1>
          </div>
          <div className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-3 py-1 text-sm text-cyan-100">
            {notams.length} candidate areas
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_380px]">
          <div
            ref={mapContainer}
            className="overflow-hidden rounded-2xl border border-slate-800 shadow-2xl"
            style={{ height: "70vh", minHeight: "420px" }}
          />

          <aside className="rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-lg">
            {selectedNotam ? (
              <>
                <div className="mb-4 border-b border-slate-700 pb-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">
                    Selected site
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold text-white">
                    {selectedNotam.location ?? "Unknown location"}
                  </h2>
                </div>

                <dl className="space-y-3 text-sm text-slate-300">
                  <div>
                    <dt className="text-slate-500">ID</dt>
                    <dd className="font-mono text-cyan-200">
                      {selectedNotam.id}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Matched terms</dt>
                    <dd>{selectedNotam.matchedTerms?.join(", ") || "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Altitude</dt>
                    <dd>
                      {selectedNotam.lowerLimit ?? "—"} to{" "}
                      {selectedNotam.upperLimit ?? "—"} ft
                    </dd>
                  </div>
                  {selectedNotam.effectiveFrom && (
                    <div>
                      <dt className="text-slate-500">Effective from</dt>
                      <dd>
                        {new Date(selectedNotam.effectiveFrom).toLocaleString()}
                      </dd>
                    </div>
                  )}
                  {selectedNotam.effectiveTo && (
                    <div>
                      <dt className="text-slate-500">Effective to</dt>
                      <dd>
                        {new Date(selectedNotam.effectiveTo).toLocaleString()}
                      </dd>
                    </div>
                  )}
                  {selectedNotam.qCode && (
                    <div>
                      <dt className="text-slate-500">Q-code</dt>
                      <dd>{selectedNotam.qCode}</dd>
                    </div>
                  )}
                </dl>

                <div className="mt-5 rounded-xl border border-slate-700 bg-slate-950 p-3">
                  <p className="mb-2 text-xs uppercase tracking-[0.2em] text-slate-400">
                    Narrative
                  </p>
                  <p className="text-sm leading-6 text-slate-200">
                    {selectedNotam.rawText}
                  </p>
                </div>
              </>
            ) : (
              <p className="text-slate-400">No NOTAM data available.</p>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
