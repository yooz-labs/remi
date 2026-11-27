import { selectableProfileIds } from '@/lib/profile-sheet-state';
import type { ProfileLookupState } from '@/lib/profile-sheet-state';
import type { SessionProfilesResponseMessage } from '@remi/shared/protocol.ts';

interface ProfilePickerProps {
  readonly directory: string;
  readonly lookup: ProfileLookupState;
  readonly selectedProfile: string | null;
  readonly creating: boolean;
  readonly error: string | null;
  readonly onSelectProfile: (profileId: string) => void;
  readonly onStart: (profileId: string) => void;
}

function refusalText(refused: unknown): string {
  switch (refused) {
    case 'directory_invalid':
      return 'That folder is not a valid directory on this machine.';
    case 'profiles_invalid':
      return "This machine's profile settings have an error. Run remi profile ls on the machine.";
    case undefined:
      return '';
    default:
      return 'The machine refused this request.';
  }
}

function defaultReason(source: unknown): string {
  switch (source) {
    case 'folder':
      return "From this folder's mapping";
    case 'machine_default':
      return "This machine's default";
    case 'built_in':
      return 'Built-in default sign-in';
    default:
      return "This machine's resolution";
  }
}

function selectableProfiles(response: SessionProfilesResponseMessage) {
  const ids = new Set(selectableProfileIds(response));
  return response.profiles.filter((profile) => ids.has(profile.id));
}

export function ProfilePicker({
  directory,
  lookup,
  selectedProfile,
  creating,
  error,
  onSelectProfile,
  onStart,
}: ProfilePickerProps) {
  const directoryRow = (
    <p className="pb-2 text-xs text-[var(--color-text-muted)]">
      Directory: {directory || 'Home folder'}
    </p>
  );

  if (lookup.status === 'idle') return null;

  if (lookup.status === 'loading') {
    return (
      <div className="border-t border-[var(--color-border)] px-5 py-3">
        {directoryRow}
        <p className="text-sm text-[var(--color-text-secondary)]">Profile: resolving…</p>
        <button
          type="button"
          disabled
          className="mt-3 w-full rounded-lg bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--color-accent-ink)] disabled:opacity-50"
        >
          Start
        </button>
      </div>
    );
  }

  if (lookup.status === 'failed') {
    return (
      <div className="border-t border-[var(--color-border)] px-5 py-3">
        {directoryRow}
        <p role="alert" className="text-sm text-[var(--color-error)]">
          {lookup.message}
        </p>
        <button
          type="button"
          disabled
          className="mt-3 w-full rounded-lg bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--color-accent-ink)] disabled:opacity-50"
        >
          Start
        </button>
      </div>
    );
  }

  const response = lookup.response;
  const profiles = selectableProfiles(response);
  const defaultChoice =
    response.default && profiles.find((profile) => profile.id === response.default?.id);
  const selectedIsOffered =
    selectedProfile !== null && profiles.some((profile) => profile.id === selectedProfile);
  const chosenProfileId = selectedIsOffered ? selectedProfile : (defaultChoice?.id ?? '');
  const chosenProfile = profiles.find((profile) => profile.id === chosenProfileId);
  const refusal = refusalText(response.refused);
  const noDefault = !response.refused && response.default === undefined;
  const defaultCannotStart = !response.refused && response.default !== undefined && !defaultChoice;
  const canStart = Boolean(!refusal && chosenProfile && !creating);
  const selectionPrompt = noDefault
    ? "This folder's own profile does not accept sessions from your devices. Choose a profile."
    : "This folder's profile cannot start a Claude session here. Choose a profile.";

  return (
    <div className="border-t border-[var(--color-border)] px-5 py-3">
      {directoryRow}
      {refusal ? (
        <p role="alert" className="text-sm text-[var(--color-error)]">
          {refusal}
        </p>
      ) : (
        <label className="flex flex-col gap-1.5 text-sm text-[var(--color-text-secondary)]">
          Profile
          <select
            aria-label="Profile"
            value={chosenProfileId}
            disabled={creating || profiles.length === 0}
            onChange={(event) => onSelectProfile(event.currentTarget.value)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[var(--color-text)]"
          >
            <option value="" disabled>
              Choose a profile
            </option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {response && !refusal && (
        <p className="pt-1.5 text-xs text-[var(--color-text-muted)]">
          {!chosenProfileId && (noDefault || defaultCannotStart)
            ? selectionPrompt
            : chosenProfileId === defaultChoice?.id
              ? defaultReason(response.default?.source)
              : 'Chosen by you'}
        </p>
      )}

      {error && (
        <p role="alert" className="pt-2 text-sm text-[var(--color-error)]">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!canStart}
        onClick={() => onStart(chosenProfileId)}
        className="mt-3 w-full rounded-lg bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--color-accent-ink)] disabled:opacity-50"
      >
        {creating ? 'Starting…' : 'Start'}
      </button>
    </div>
  );
}
