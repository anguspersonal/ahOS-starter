import {
  formatChannelLabel,
  type JobPipelineApplicationItem,
  type JobPipelineChannelSummary,
  type JobPipelineOrganisationSummary,
  type JobPipelineRecruiterSummary,
} from "../../lib/jobHuntActions.js";
import { StagePill } from "./StagePill.js";

export function OrganisationsTable({
  organisations,
  applications,
}: {
  organisations: readonly JobPipelineOrganisationSummary[];
  applications: readonly JobPipelineApplicationItem[];
}) {
  return (
    <div id="panel-organisations" role="tabpanel" className="pt-3">
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
        <table data-testid="jh-organisations-table" className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              <th className="text-left py-2.5 px-3">Organisation</th>
              <th className="text-right py-2.5 px-3">Applications</th>
              <th className="text-right py-2.5 px-3">Submitted</th>
              <th className="text-left py-2.5 px-3">Roles &amp; stages</th>
            </tr>
          </thead>
          <tbody>
            {organisations.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-8 text-center text-slate-400">
                  No organisations recorded yet.
                </td>
              </tr>
            ) : (
              organisations.map((org) => {
                const orgApps = applications.filter(
                  (a) =>
                    (org.id && a.organisation?.id === org.id) ||
                    (!org.id && (a.organisation_name ?? "Unknown") === org.title),
                );
                return (
                  <tr
                    key={org.id ?? org.title}
                    className="border-b border-slate-800/60 align-top hover:bg-slate-800/40"
                  >
                    <td className="py-3 px-3 font-semibold text-white">{org.title}</td>
                    <td className="py-3 px-3 text-right tabular-nums text-slate-200">
                      {org.application_count}
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums text-slate-300">
                      {org.submitted_count}
                    </td>
                    <td className="py-3 px-3 space-y-1.5">
                      {orgApps.length > 0 ? (
                        orgApps.map((app) => (
                          <div key={app.id} className="flex flex-wrap items-center gap-2">
                            <span className="text-slate-200">{app.role_title}</span>
                            <StagePill application={app} />
                          </div>
                        ))
                      ) : (
                        <span className="text-slate-400">
                          {Object.entries(org.stages)
                            .map(([st, cnt]) => `${st}: ${cnt}`)
                            .join(", ")}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function JobSitesTable({
  jobSites,
}: {
  jobSites: readonly JobPipelineChannelSummary[];
}) {
  return (
    <div id="panel-job-sites" role="tabpanel" className="pt-3">
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
        <table data-testid="jh-job-sites-table" className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              <th className="text-left py-2.5 px-3">Job site / channel</th>
              <th className="text-right py-2.5 px-3">Total</th>
              <th className="text-right py-2.5 px-3">Submitted</th>
              <th className="text-right py-2.5 px-3">Interviews</th>
              <th className="text-right py-2.5 px-3">Rejected</th>
              <th className="text-right py-2.5 px-3">No reply</th>
              <th className="text-left py-2.5 px-3 min-w-[160px]">Interview rate</th>
            </tr>
          </thead>
          <tbody>
            {jobSites.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-400">
                  No job sites or channels recorded yet.
                </td>
              </tr>
            ) : (
              jobSites.map((site) => {
                const ratePct =
                  site.submitted > 0 ? Math.round(site.interview_rate * 100) : null;
                return (
                  <tr
                    key={site.channel}
                    className="border-b border-slate-800/60 align-middle hover:bg-slate-800/40"
                  >
                    <td className="py-3 px-3">
                      <div className="font-semibold text-white">
                        {site.job_site?.title ?? formatChannelLabel(site.channel)}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {formatChannelLabel(site.channel)}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums text-slate-300">
                      {site.total}
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums text-slate-200">
                      {site.submitted}
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums text-white font-semibold">
                      {site.reached_interview}
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums text-slate-300">
                      {site.rejected}
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums text-slate-300">
                      {site.silent}
                    </td>
                    <td className="py-3 px-3">
                      {ratePct === null ? (
                        <span className="text-slate-400">No applications yet</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-slate-800 rounded overflow-hidden">
                            <div
                              className="h-full rounded-r"
                              style={{
                                width: `${ratePct}%`,
                                backgroundColor: "var(--jh-series-interview)",
                              }}
                            />
                          </div>
                          <span className="tabular-nums text-slate-200 font-medium w-9 text-right">
                            {ratePct}%
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RecruitersTable({
  recruiters,
  applications,
}: {
  recruiters: readonly JobPipelineRecruiterSummary[];
  applications: readonly JobPipelineApplicationItem[];
}) {
  const appById = new Map(applications.map((a) => [a.id, a]));

  return (
    <div id="panel-recruiters" role="tabpanel" className="pt-3">
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
        <table data-testid="jh-recruiters-table" className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              <th className="text-left py-2.5 px-3">Name</th>
              <th className="text-left py-2.5 px-3">Role</th>
              <th className="text-right py-2.5 px-3">Applications</th>
              <th className="text-left py-2.5 px-3">Covered roles</th>
            </tr>
          </thead>
          <tbody>
            {recruiters.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-8 text-center text-slate-400">
                  No recruiters or hiring contacts linked yet.
                </td>
              </tr>
            ) : (
              recruiters.map((rec) => (
                <tr
                  key={`${rec.role}-${rec.id}`}
                  className="border-b border-slate-800/60 align-top hover:bg-slate-800/40"
                >
                  <td className="py-3 px-3 font-semibold text-white">{rec.title}</td>
                  <td className="py-3 px-3 text-slate-300">
                    {rec.role === "recruiter" ? "Recruiter" : "Hiring contact"}
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums text-slate-200">
                    {rec.application_count}
                  </td>
                  <td className="py-3 px-3 text-slate-300 space-y-1">
                    {rec.application_ids.map((appId) => {
                      const app = appById.get(appId);
                      return (
                        <div key={appId}>
                          {app ? `${app.organisation_name ?? app.title} · ${app.role_title}` : appId}
                        </div>
                      );
                    })}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
