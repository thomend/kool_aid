import type { GraphMeta, LayoutMeta } from "../api";
import { formatLength } from "../format";
import { CloseIcon } from "./Icons";

interface Props {
  meta: GraphMeta;
  /** Set while the cost-space view is active. */
  layout: LayoutMeta | null;
  onClose: () => void;
}

export function InfoPopup({ meta, layout, onClose }: Props) {
  return (
    <section className="info-popup glass" role="dialog" aria-label="About this map">
      <button className="icon-button close" aria-label="Close" onClick={onClose}>
        <CloseIcon />
      </button>
      <h3>About this map</h3>
      <p className="small">
        Walking cost is length stretched by heat stress (PET), so hot, shadeless streets cost
        more to walk than cool, comfortable ones. Edges are coloured by heat cost per metre
        compared with a typical metre of Basel without trees and fountains: red streets are
        hotter than that, teal ones cooler.
      </p>
      <p className="small">
        Heat only counts above 29 °C PET, where moderate heat stress begins, and then grows
        quadratically. <strong>Heat sensitivity</strong> sets how steeply: <em>low</em> for fit
        adults on short trips, <em>high</em> for elderly people, small children or anyone with a
        heart condition.
      </p>
      <p className="small">
        <strong>Tree shade</strong> softens the heat: the part of a street under a public tree's
        crown counts only half of its extra heat cost. <strong>Fountains</strong> offer a drink
        and a cool-down: within 100 m of one, a street loses a fifth of its extra heat cost.
        Switch either off under <em>Count in</em> to see what they change: colours and the cost
        space are always measured against Basel without trees and fountains, so streets they
        help turn cooler and the city draws together.
      </p>
      {layout ? (
        <CostSpaceNote layout={layout} />
      ) : (
        <p className="footnote">
          {meta.component_count - 1} small disconnected pieces are shown faded. Zoom in to see
          intersections.
        </p>
      )}
    </section>
  );
}

function CostSpaceNote({ layout }: { layout: LayoutMeta }) {
  const spread = Math.max(1 - layout.edge_stretch_p05, layout.edge_stretch_p95 - 1);
  return (
    <>
      <p className="section-label">Cost space</p>
      <p className="small">
        Every edge is drawn as long as its cost relative to a typical metre without trees and
        fountains: hotter streets stretch, cooler ones shrink. The grid is warped
        along with the network, so stretched cells mark heat-stressed areas and squeezed cells
        cool ones.
      </p>
      <dl className="mini-stats">
        <div>
          <dt>Edge length vs cost</dt>
          <dd>±{Math.max(1, Math.round(spread * 100))} %</dd>
        </div>
        <div>
          <dt>Largest shift</dt>
          <dd>{formatLength(layout.displacement_max_m)}</dd>
        </div>
      </dl>
      <p className="footnote">Only the connected main network is shown.</p>
    </>
  );
}
