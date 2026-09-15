import { useI18n } from "../lib/i18n";

interface PrivacyNoticeProps {
  projectRoot?: string;
  onClose: () => void;
}

export default function PrivacyNotice({ projectRoot, onClose }: PrivacyNoticeProps) {
  const { t } = useI18n();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t("privacy.title")}</span>
          <button className="text-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {projectRoot ? (
            <p className="modal-hint privacy-path" title={projectRoot}>
              {t("privacy.currentlyOpen")} <code className="inline-code">{projectRoot}</code>
            </p>
          ) : (
            <p className="modal-hint">{t("privacy.noFolder")}</p>
          )}

          <ul className="privacy-list">
            <li>{t("privacy.point1")}</li>
            <li>{t("privacy.point2")}</li>
            <li>{t("privacy.point3")}</li>
            <li>{t("privacy.point4")}</li>
            <li>{t("privacy.point5")}</li>
            <li>{t("privacy.point6")}</li>
          </ul>

          <p className="modal-hint">{t("privacy.footer")}</p>
        </div>
      </div>
    </div>
  );
}
