import { useState } from "react";
import {
  APPLICATION_CHANNELS,
  JOB_APPLICATION_STAGES,
  ROLE_CATEGORIES,
  toDateInputValue,
  type ApplicationChannel,
  type JobApplicationCandidate,
  type JobApplicationStage,
  type JobApplicationUpsertClientInput,
  type JobPipelineApplicationItem,
  type RoleCategory,
} from "../../lib/jobHuntActions.js";

export interface ApplicationUpsertFormProps {
  editingApp?: JobPipelineApplicationItem | null;
  busy?: boolean;
  ambiguousCandidates?: readonly JobApplicationCandidate[];
  onSubmit: (input: JobApplicationUpsertClientInput) => void | Promise<void>;
  onSelectAmbiguousCandidate?: (candidateId: string) => void | Promise<void>;
  onCancel: () => void;
}

export interface ApplicationUpsertFormFields {
  editingApp?: JobPipelineApplicationItem | null;
  organisation: string;
  roleTitle: string;
  roleCategory: RoleCategory;
  channel: ApplicationChannel;
  stage: JobApplicationStage;
  appliedOn: string;
  jobSite: string;
  ats: string;
  platformRef: string;
  cvEntityId: string;
  notes: string;
}

export function buildApplicationUpsertPayload(
  fields: ApplicationUpsertFormFields,
): JobApplicationUpsertClientInput {
  return {
    ...(fields.editingApp ? { id: fields.editingApp.id } : {}),
    organisation: fields.organisation.trim() || undefined,
    role_title: fields.roleTitle.trim() || undefined,
    role_category: fields.roleCategory,
    channel: fields.channel,
    stage: fields.stage,
    applied_on: fields.appliedOn.trim()
      ? fields.appliedOn.trim()
      : fields.editingApp?.applied_on
        ? null
        : undefined,
    job_site: fields.jobSite.trim() || undefined,
    ats: fields.ats.trim() ? fields.ats.trim() : null,
    platform_ref: fields.platformRef.trim() ? fields.platformRef.trim() : null,
    cv_entity_id: fields.cvEntityId.trim() ? fields.cvEntityId.trim() : null,
    notes: fields.notes.trim() ? fields.notes.trim() : null,
  };
}

export function ApplicationUpsertForm({
  editingApp = null,
  busy = false,
  ambiguousCandidates = [],
  onSubmit,
  onSelectAmbiguousCandidate,
  onCancel,
}: ApplicationUpsertFormProps) {
  const [organisation, setOrganisation] = useState(
    editingApp?.organisation_name ?? "",
  );
  const [roleTitle, setRoleTitle] = useState(editingApp?.role_title ?? "");
  const [roleCategory, setRoleCategory] = useState<RoleCategory>(
    editingApp?.role_category ?? "product",
  );
  const [channel, setChannel] = useState<ApplicationChannel>(
    editingApp?.channel ?? "company_site",
  );
  const [stage, setStage] = useState<JobApplicationStage>(
    editingApp?.stage ?? "identified",
  );
  const [appliedOn, setAppliedOn] = useState(
    toDateInputValue(editingApp?.applied_on),
  );
  const [jobSite, setJobSite] = useState(editingApp?.job_site?.title ?? "");
  const [ats, setAts] = useState(editingApp?.ats ?? "");
  const [platformRef, setPlatformRef] = useState(
    editingApp?.platform_ref ?? "",
  );
  const [cvEntityId, setCvEntityId] = useState(editingApp?.cv?.id ?? "");
  const [notes, setNotes] = useState(editingApp?.notes ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = buildApplicationUpsertPayload({
      editingApp,
      organisation,
      roleTitle,
      roleCategory,
      channel,
      stage,
      appliedOn,
      jobSite,
      ats,
      platformRef,
      cvEntityId,
      notes,
    });
    void onSubmit(payload);
  };

  const fieldCls =
    "w-full px-2.5 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-slate-200";
  const labelCls = "block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1";

  return (
    <form
      data-testid="jh-upsert-form"
      onSubmit={handleSubmit}
      className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">
          {editingApp ? `Edit application: ${editingApp.title}` : "Add job application"}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
        >
          Cancel
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label htmlFor="jh-form-org" className={labelCls}>
            Organisation
          </label>
          <input
            id="jh-form-org"
            type="text"
            required={!editingApp}
            value={organisation}
            onChange={(e) => setOrganisation(e.target.value)}
            placeholder="e.g. Telemachus"
            className={fieldCls}
          />
        </div>

        <div>
          <label htmlFor="jh-form-role" className={labelCls}>
            Role title
          </label>
          <input
            id="jh-form-role"
            type="text"
            required={!editingApp}
            value={roleTitle}
            onChange={(e) => setRoleTitle(e.target.value)}
            placeholder="e.g. Special Projects Lead"
            className={fieldCls}
          />
        </div>

        <div>
          <label htmlFor="jh-form-category" className={labelCls}>
            Role category
          </label>
          <select
            id="jh-form-category"
            value={roleCategory}
            onChange={(e) => setRoleCategory(e.target.value as RoleCategory)}
            className={fieldCls}
          >
            {ROLE_CATEGORIES.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.display}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="jh-form-channel" className={labelCls}>
            Channel
          </label>
          <select
            id="jh-form-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as ApplicationChannel)}
            className={fieldCls}
          >
            {APPLICATION_CHANNELS.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.display}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="jh-form-stage" className={labelCls}>
            Stage
          </label>
          <select
            id="jh-form-stage"
            value={stage}
            onChange={(e) => setStage(e.target.value as JobApplicationStage)}
            className={fieldCls}
          >
            {JOB_APPLICATION_STAGES.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.display}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="jh-form-applied" className={labelCls}>
            Applied date
          </label>
          <input
            id="jh-form-applied"
            type="date"
            value={appliedOn}
            onChange={(e) => setAppliedOn(e.target.value)}
            className={fieldCls}
          />
        </div>

        <div>
          <label htmlFor="jh-form-jobsite" className={labelCls}>
            Job site (optional)
          </label>
          <input
            id="jh-form-jobsite"
            type="text"
            value={jobSite}
            onChange={(e) => setJobSite(e.target.value)}
            placeholder="e.g. Jumpstart or Dex jobs"
            className={fieldCls}
          />
        </div>

        <div>
          <label htmlFor="jh-form-ats" className={labelCls}>
            ATS (optional)
          </label>
          <input
            id="jh-form-ats"
            type="text"
            value={ats}
            onChange={(e) => setAts(e.target.value)}
            placeholder="e.g. ashby, lever, greenhouse"
            className={fieldCls}
          />
        </div>

        <div>
          <label htmlFor="jh-form-ref" className={labelCls}>
            Platform ref (optional)
          </label>
          <input
            id="jh-form-ref"
            type="text"
            value={platformRef}
            onChange={(e) => setPlatformRef(e.target.value)}
            placeholder="e.g. B28-00397"
            className={fieldCls}
          />
        </div>

        <div>
          <label htmlFor="jh-form-cv" className={labelCls}>
            CV entity UUID (optional)
          </label>
          <input
            id="jh-form-cv"
            type="text"
            value={cvEntityId}
            onChange={(e) => setCvEntityId(e.target.value)}
            placeholder="UUID for references edge"
            className={fieldCls}
          />
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="jh-form-notes" className={labelCls}>
            Notes
          </label>
          <input
            id="jh-form-notes"
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Factual context, screen summary, or next step"
            className={fieldCls}
          />
        </div>
      </div>

      {ambiguousCandidates.length > 0 && (
        <div
          role="region"
          aria-label="Disambiguate matching application"
          className="p-3 bg-amber-950/30 border border-amber-700/60 rounded-lg space-y-2 text-xs"
        >
          <p className="font-semibold text-amber-400">
            Multiple matches found. Pick an existing application to update:
          </p>
          <div className="flex flex-wrap gap-2">
            {ambiguousCandidates.map((cand) => (
              <button
                key={cand.id}
                type="button"
                disabled={busy}
                onClick={() => void onSelectAmbiguousCandidate?.(cand.id)}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
              >
                {cand.title} ({cand.stage ?? "unknown"}) — {cand.match_reason}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={busy}
          className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white"
        >
          {busy ? "Saving..." : editingApp ? "Save changes" : "Create application"}
        </button>
      </div>
    </form>
  );
}
