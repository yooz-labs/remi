import type { SessionProfilesResponseMessage } from '@remi/shared/protocol.ts';

interface ProfilePickerProps {
  readonly loading: boolean;
  readonly response?: SessionProfilesResponseMessage | null;
  readonly selectedProfile?: string | null;
  readonly creating?: boolean;
  readonly error?: string | null;
  readonly onSelectProfile: (profileId: string) => void;
  readonly onStart: (profileId: string) => void;
}

function refusalText(refused: unknown): string {
  switch (refused) {
    case 'directory_invalid':
      return 'That folder is not a valid directory on this machine.';
    case 'profiles_invalid':
      return 'This machine\'s profile settings have an error. Run remi profile ls on the machine.';
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

export function ProfilePicker({
  loading,
  response = null,
  selectedProfile = null,
  creating = false,
  error = null,
  onSelectProfile,
  onStart,
}: ProfilePickerProps) {
  if (loading) {
    return (
      <div className="border-t border-[var(--color-border)] px-5 py-3">
        <p className="text-sm text-[var(--color-text-secondary)]">Profile: resolving…</p>
      </div>
    );
  }

  if (!response) {
    return (
      <div className="border-t border-[var(--color-border)] px-5 py-3">
        <p role="alert" className="text-sm text-[var(--color-error)]">
          Unable to load profiles from this machine.
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

  const listedProfiles = Array.isArray(response.profiles) ? response.profiles : [];
  const profiles = listedProfiles.filter(
    (profile) =>
      profile &&
      typeof profile.id === 'string' &&
      typeof profile.label === 'string' &&
      Array.isArray(profile.harnesses) &&
      profile.harnesses.includes('claude'),
  );
  const defaultChoice =
    response.default && profiles.find((profile) => profile.id === response.default?.id);
  const chosenProfileId = selectedProfile ?? defaultChoice?.id ?? '';
  const chosenProfile = profiles.find((profile) => profile.id === chosenProfileId);
  const refusal = refusalText(response.refused);
  const noDefault = !response.refused && !defaultChoice;
  const canStart = Boolean(response && !refusal && chosenProfile && !creating);

  return (
    <div className="border-t border-[var(--color-border)] px-5 py-3">
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
            disabled={!response || creating || profiles.length === 0}
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
          {noDefault
            ? "This folder's own profile does not accept sessions from your devices. Choose a profile."
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
