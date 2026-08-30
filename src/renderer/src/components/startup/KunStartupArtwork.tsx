import type { ReactElement } from 'react'
import kunWordmarkUrl from '../../assets/startup/kun-startup-wordmark.webp'
import {
  KUN_STARTUP_VARIANT_CONFIG,
  type KunStartupVariant
} from './kun-startup-variants'

export type KunStartupMotion = 'running' | 'paused'

export function KunStartupArtwork({
  motion,
  variant = 'signal'
}: {
  motion: KunStartupMotion
  variant?: KunStartupVariant
}): ReactElement {
  const variantConfig = KUN_STARTUP_VARIANT_CONFIG[variant]

  return (
    <div
      className="kun-startup__artwork kun-startup__motion"
      data-motion={motion}
      data-variant={variant}
      data-testid="kun-startup-artwork"
      aria-hidden="true"
    >
      <span className="kun-startup-artwork__ground-glow kun-startup__motion" />
      <span className="kun-startup-artwork__variant-aura kun-startup__motion" />
      <span className="kun-startup-artwork__variant-streaks kun-startup__motion" />
      <span className="kun-startup-artwork__prop-wrap kun-startup__motion">
        <img
          className="kun-startup-artwork__prop"
          src={variantConfig.propUrl}
          width="384"
          height="384"
          alt=""
          draggable={false}
          data-variant={variant}
          data-testid="kun-startup-prop"
        />
      </span>

      <div
        className="kun-startup-artwork__orbit"
        data-testid="kun-startup-orbit"
      >
        <span className="kun-startup-artwork__orbit-track" />
        <span className="kun-startup-artwork__orbit-runner kun-startup__motion">
          <span className="kun-startup-artwork__particle" />
        </span>
        <span className="kun-startup-artwork__orbit-runner kun-startup-artwork__orbit-runner--secondary kun-startup__motion">
          <span className="kun-startup-artwork__particle kun-startup-artwork__particle--secondary" />
        </span>
      </div>

      <div className="kun-startup-artwork__console" aria-hidden="true">
        <span className="kun-startup-artwork__console-grid" />
        <span
          className="kun-startup-artwork__console-core kun-startup__motion"
          data-testid="kun-startup-console-glow"
        />
      </div>

      <span
        className="kun-startup-artwork__hologram kun-startup__motion"
        data-testid="kun-startup-hologram"
        data-wordmark="KUN"
      >
        <img
          className="kun-startup-artwork__wordmark"
          src={kunWordmarkUrl}
          width="720"
          height="248"
          alt=""
          draggable={false}
          data-testid="kun-startup-wordmark"
        />
        <span className="kun-startup-artwork__hologram-scan kun-startup__motion" />
        <span className="kun-startup-artwork__hologram-nodes kun-startup__motion">
          <i />
          <i />
          <i />
          <i />
        </span>
      </span>

      <span className="kun-startup-artwork__bird-wrap kun-startup__motion">
        <img
          className="kun-startup-artwork__bird"
          src={variantConfig.birdUrl}
          width="384"
          height="384"
          alt=""
          draggable={false}
          data-variant={variant}
          data-testid="kun-startup-bird"
        />
      </span>

      <span className="kun-startup-artwork__character-wrap kun-startup__motion">
        <img
          className="kun-startup-artwork__character"
          src={variantConfig.avatarUrl}
          width="768"
          height="768"
          alt=""
          draggable={false}
          data-variant={variant}
          data-testid="kun-startup-kun"
        />
      </span>
    </div>
  )
}
