import type { Guid, NodeChange } from '../fig/kiwi.js';

/**
 * Figma prototype interactions -> Penpot shape interactions.
 * The official plugin does not export these at all; the .fig carries them as
 * prototypeInteractions: [{ event: { interactionType, transitionTimeout },
 * actions: [{ connectionType, navigationType, transitionNodeID,
 * transitionType, transitionDuration, easingType, connectionURL }] }].
 */

const UINT_SENTINEL = 4294967295;

const EVENTS: Record<string, string> = {
  ON_CLICK: 'click',
  MOUSE_UP: 'click',
  ON_PRESS: 'mouse-press',
  MOUSE_DOWN: 'mouse-press',
  ON_HOVER: 'mouse-over',
  MOUSE_ENTER: 'mouse-enter',
  MOUSE_LEAVE: 'mouse-leave',
  AFTER_TIMEOUT: 'after-delay',
};

const EASINGS: Record<string, string> = {
  LINEAR: 'linear',
  EASE_IN: 'ease-in',
  EASE_OUT: 'ease-out',
  EASE_IN_AND_OUT: 'ease-in-out',
  EASE_IN_BACK: 'ease-in',
  EASE_OUT_BACK: 'ease-out',
  EASE_IN_AND_OUT_BACK: 'ease-in-out',
  GENTLE_SPRING: 'ease-out',
  CUSTOM_CUBIC_BEZIER: 'ease',
};

const DIRECTIONS: Record<string, string> = {
  LEFT: 'left',
  RIGHT: 'right',
  TOP: 'up',
  BOTTOM: 'down',
};

interface FigAction {
  connectionType?: string;
  navigationType?: string;
  transitionNodeID?: Guid;
  transitionType?: string;
  transitionDuration?: number;
  easingType?: string;
  transitionDirection?: string;
  connectionURL?: string;
  overlayRelativePosition?: { x: number; y: number };
}

interface FigInteraction {
  event?: { interactionType?: string; transitionTimeout?: number };
  actions?: FigAction[];
  isDeleted?: boolean;
}

function animationFor(action: FigAction): Record<string, unknown> | undefined {
  const duration = Math.round((action.transitionDuration ?? 0.3) * 1000);
  const easing = EASINGS[action.easingType ?? ''] ?? 'linear';
  const direction = DIRECTIONS[action.transitionDirection ?? ''] ?? 'right';
  switch (action.transitionType) {
    case 'DISSOLVE':
      return { animationType: 'dissolve', duration, easing };
    case 'PUSH':
      return { animationType: 'push', duration, easing, direction };
    case 'MOVE_IN':
    case 'SLIDE_IN':
      return { animationType: 'slide', duration, easing, direction, way: 'in', offsetEffect: false };
    case 'MOVE_OUT':
    case 'SLIDE_OUT':
      return { animationType: 'slide', duration, easing, direction, way: 'out', offsetEffect: false };
    default:
      // SMART_ANIMATE and instant transitions have no Penpot equivalent.
      return undefined;
  }
}

/** destination resolver: target frame guid -> emitted Penpot shape uuid (or undefined). */
export type DestinationResolver = (guid: Guid) => string | undefined;

export function convertInteractions(
  node: NodeChange,
  resolveDestination: DestinationResolver,
): Record<string, unknown>[] {
  const interactions: Record<string, unknown>[] = [];
  for (const interaction of (node['prototypeInteractions'] as FigInteraction[] | undefined) ?? []) {
    if (interaction.isDeleted) continue;
    const eventType = EVENTS[interaction.event?.interactionType ?? ''];
    if (!eventType) continue;
    const delay =
      eventType === 'after-delay'
        ? { delay: Math.round((interaction.event?.transitionTimeout ?? 0.3) * 1000) }
        : {};

    for (const action of interaction.actions ?? []) {
      const target = action.transitionNodeID;
      const hasTarget = target && target.sessionID !== UINT_SENTINEL;
      const animation = animationFor(action);
      const animationAttr = animation ? { animation } : {};

      if (action.connectionType === 'BACK') {
        interactions.push({ eventType, actionType: 'prev-screen', ...delay });
        continue;
      }
      if (action.connectionType === 'URL' && action.connectionURL) {
        interactions.push({ eventType, actionType: 'open-url', url: action.connectionURL, ...delay });
        continue;
      }
      if (action.connectionType === 'CLOSE') {
        interactions.push({ eventType, actionType: 'close-overlay', ...delay });
        continue;
      }
      if (action.connectionType !== 'INTERNAL_NODE' || !hasTarget) continue;

      const destination = resolveDestination(target);
      if (!destination) continue; // target not part of this conversion

      switch (action.navigationType) {
        case 'NAVIGATE':
          interactions.push({ eventType, actionType: 'navigate', destination, ...animationAttr, ...delay });
          break;
        case 'OVERLAY':
          interactions.push({
            eventType,
            actionType: 'open-overlay',
            destination,
            overlayPosType: 'center',
            closeClickOutside: true,
            ...animationAttr,
            ...delay,
          });
          break;
        default:
          // SWAP_STATE / SCROLL_TO have no Penpot interaction equivalent.
          break;
      }
    }
  }
  return interactions;
}
