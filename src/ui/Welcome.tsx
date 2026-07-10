import { controller, type Snapshot } from '../core/controller';

export default function Welcome({ snap }: { snap: Snapshot }) {
  if (snap.docOpen) return null;
  return (
    <div id="welcome" className="absolute inset-0 flex items-center justify-center">
      <div className="text-center text-dim max-w-115">
        <h1 className="text-fgapp font-semibold text-[22px]">PDF Stack Reader</h1>
        <p className="mt-3 leading-relaxed">
          A PDF reader that remembers <em>how</em> you got where you are.<br />
          Every reference you follow is pushed onto a history stack, so you can<br />
          dive many levels deep and pop back to the exact spot you left.<br />
          Cmd-click a link to fork the whole history into a new stack.
        </p>
        <button
          className="mt-4 bg-accent text-white text-sm px-4.5 py-2 rounded-lg cursor-pointer hover:brightness-110"
          onClick={() => void controller.pickFile()}
        >
          Choose a PDF&hellip;
        </button>
        <p className="text-xs mt-2">or drop a file anywhere</p>

        {snap.recents.length > 0 && (
          <div id="recent" className="mt-5 text-left">
            <h3 className="text-dim text-xs uppercase tracking-wider mb-1">Recent</h3>
            {snap.recents.map((r) => (
              <div
                key={r.fp}
                className="recentItem px-2.5 py-1.5 rounded-md cursor-pointer text-fgapp hover:bg-hoverrow overflow-hidden text-ellipsis whitespace-nowrap"
                onClick={() => void controller.openRecent(r)}
              >
                {r.name}
                <span className="text-dim text-[11px] ml-2">
                  {new Date(r.ts).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
