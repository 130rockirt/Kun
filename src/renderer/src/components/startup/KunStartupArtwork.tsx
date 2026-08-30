import type { ReactElement } from 'react'
import kunAvatarUrl from '../../assets/startup/kun-startup-avatar.webp'
import kunBirdUrl from '../../assets/startup/kun-startup-bird.webp'
import kunWordmarkUrl from '../../assets/startup/kun-startup-wordmark.webp'

export type KunStartupMotion = 'running' | 'paused'

export function KunStartupArtwork({
  motion
}: {
  motion: KunStartupMotion
}): ReactElement {
  return (
    <div
      className="kun-startup__artwork kun-startup__motion"
      data-motion={motion}
      data-testid="kun-startup-artwork"
      aria-hidden="true"
    >
      <span className="kun-startup-artwork__ground-glow kun-startup__motion" />

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
          src={kunBirdUrl}
          width="384"
          height="262"
          alt=""
          draggable={false}
          data-testid="kun-startup-bird"
        />
      </span>

      <span className="kun-startup-artwork__character-wrap kun-startup__motion">
        <img
          className="kun-startup-artwork__character"
          src={kunAvatarUrl}
          width="768"
          height="768"
          alt=""
          draggable={false}
          data-testid="kun-startup-kun"
        />
      </span>
    </div>
  )
}
