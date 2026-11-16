/** Procedural scene inside the native app; never an outer desktop or nested window. */
export default function LiquidBackdrop() {
  return <div className="liquid-backdrop" aria-hidden="true">
    <div className="liquid-base" /><div className="liquid-ambient" />
    <svg className="liquid-ribbons" viewBox="0 0 1672 941" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="v2-violet" x1="0" y1="1" x2="1" y2="0"><stop stopColor="#454cb4" /><stop offset=".4" stopColor="#ad7bd8" /><stop offset=".7" stopColor="#e3bcff" /><stop offset="1" stopColor="#7568ce" /></linearGradient>
        <linearGradient id="v2-blue" x1="0" y1="1" x2="1" y2="0"><stop stopColor="#1d3c82" /><stop offset=".5" stopColor="#4395ef" /><stop offset=".74" stopColor="#7bcaff" /><stop offset="1" stopColor="#294e9e" /></linearGradient>
        <linearGradient id="v2-magenta"><stop stopColor="#ab6ad5" /><stop offset=".45" stopColor="#f4b9e8" /><stop offset="1" stopColor="#9d79d3" /></linearGradient>
        <filter id="v2-atmosphere"><feGaussianBlur stdDeviation="18" /></filter>
        <filter id="v2-soft"><feGaussianBlur stdDeviation="4" /></filter>
      </defs>
      <g opacity=".46" filter="url(#v2-atmosphere)">
        <path d="M-180 499 Q154 209 398 -149 L174 -139 Q87 107 -100 227Z" fill="url(#v2-violet)" />
        <path d="M164 1122 Q581 534 1072 -100 L912 -152 Q448 429 -68 1077Z" fill="url(#v2-violet)" opacity=".34" />
        <path d="M665 1112 Q1213 748 1850 210 L1771 89 Q1198 584 522 1049Z" fill="url(#v2-magenta)" />
        <path d="M1181 1117 Q1435 823 1811 622 L1803 436 Q1405 671 998 1076Z" fill="url(#v2-blue)" />
      </g>
      <g fill="none" filter="url(#v2-soft)">
        <path d="M-64 418 Q207 172 342 -50" stroke="url(#v2-violet)" strokeWidth="13" opacity=".8" />
        <path d="M-51 784 Q373 472 779 -53" stroke="url(#v2-blue)" strokeWidth="12" opacity=".5" />
        <path d="M879 1024 Q1340 690 1729 349" stroke="url(#v2-magenta)" strokeWidth="17" opacity=".42" />
        <path d="M1268 1009 Q1530 761 1741 630" stroke="url(#v2-blue)" strokeWidth="16" opacity=".6" />
      </g>
    </svg>
    <div className="liquid-atmosphere" /><div className="liquid-cover-light" />
  </div>;
}
