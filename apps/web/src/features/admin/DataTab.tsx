import { AdminSimpleTable } from "./AdminPrimitives";
import { formatNumber } from "./format";
import type { AdminSummary } from "./types";

export function DataTab({ summary }: { summary: AdminSummary }) {
  const averageUpdatesPerDay = summary.activity.completionUpdates7d / 7;
  const averageUsersPerDay = summary.activity.completionUsers7d / 7;

  return (
    <div className="admin-tab-panel">
      <section className="admin-section" aria-labelledby="admin-data-users-heading">
        <h3 id="admin-data-users-heading">유저 흐름</h3>
        <AdminSimpleTable
          columns={["값", "설명"]}
          rows={[
            { key: "users-created-24h", label: "최근 24시간 신규 가입", values: [summary.users.created24h, "가입 유입"] },
            { key: "users-created-7d", label: "최근 7일 신규 가입", values: [summary.users.created7d, "가입 증가 흐름"] },
            { key: "completion-users-7d", label: "최근 7일 체크 유저", values: [summary.activity.completionUsers7d, "실사용자 추정"] },
            { key: "active-sessions", label: "활성 세션", values: [summary.users.activeSessions, "로그인 유지 세션"] }
          ]}
        />
      </section>

      <section className="admin-section" aria-labelledby="admin-data-checks-heading">
        <h3 id="admin-data-checks-heading">체크 사용량</h3>
        <AdminSimpleTable
          columns={["최근 24시간", "최근 7일", "1일 평균"]}
          rows={[
            {
              key: "check-users",
              label: "체크 유저",
              values: [summary.activity.completionUsers24h, summary.activity.completionUsers7d, `${averageUsersPerDay.toFixed(1)} / day`]
            },
            {
              key: "check-updates",
              label: "체크 변경",
              values: [
                summary.activity.completionUpdates24h,
                summary.activity.completionUpdates7d,
                `${averageUpdatesPerDay.toFixed(1)} / day`
              ]
            }
          ]}
        />
      </section>

      <section className="admin-section" aria-labelledby="admin-data-scale-heading">
        <h3 id="admin-data-scale-heading">데이터 규모</h3>
        <AdminSimpleTable
          columns={["구성 1", "구성 2", "구성 3"]}
          rows={[
            {
              key: "board-structure",
              label: "보드 구조",
              values: [
                `분류 ${formatNumber(summary.data.sheets)}개`,
                `표 ${formatNumber(summary.data.tables)}개`,
                `항목 ${formatNumber(summary.data.axisItems)}개`
              ]
            },
            {
              key: "check-state",
              label: "체크 데이터",
              values: [
                `셀 상태 ${formatNumber(summary.data.cellStates)}개`,
                `체크 기록 ${formatNumber(summary.data.boardCompletions)}개`,
                ""
              ]
            },
            {
              key: "content",
              label: "컨텐츠",
              values: [
                `캐릭터 ${formatNumber(summary.data.characters)}개`,
                `숙제 ${formatNumber(summary.data.tasks)}개`,
                `메모 ${formatNumber(summary.data.notes)}개`
              ]
            },
            {
              key: "sharing",
              label: "공유",
              values: [`공유 ${formatNumber(summary.data.shares)}개`, `즐겨찾기 ${formatNumber(summary.data.shareFavorites)}개`, ""]
            }
          ]}
        />
      </section>
    </div>
  );
}
