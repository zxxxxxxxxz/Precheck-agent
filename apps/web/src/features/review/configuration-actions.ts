import type {ReviewConfigView} from '@hsbc/contracts/review-config';

const definitions = [
  {action: 'validate', grant: 'rule:propose', label: '校验配置', permission: '配置维护'},
  {action: 'trial', grant: 'rule:trial', label: '运行试例', permission: '试跑'},
  {action: 'approve', grant: 'rule:approve', label: '批准此版本', permission: '审批'},
  {action: 'publish', grant: 'rule:publish', label: '发布此版本', permission: '发布'},
] as const;

export type ConfigAction = typeof definitions[number]['action'];
type ActionView = Pick<ReviewConfigView, 'status' | 'validation' | 'trial' | 'approval' | 'allowed_actions'>;

/** Session grants explain unavailable actions; only the draft response can enable them. */
export function configurationActions(current: ActionView, sessionActions: readonly string[], editing = false, pending = false) {
  return definitions.map(definition => {
    const reason = (): string | undefined => {
      if (current.status === 'published') return '此版本已发布。';
      if (editing) return '请先保存或放弃未保存的修改。';
      if (pending) return '正在处理，请稍候。';
      if (definition.action === 'trial' && !current.validation.valid) {
        if (!sessionActions.includes(definition.grant)) return '当前账号没有试跑权限。';
        return '请先修正配置校验问题。';
      }
      if (definition.action === 'approve' && (current.status !== 'trial_passed' || !current.trial?.passed)) {
        if (current.approval) return '此版本已批准。';
        if (!sessionActions.includes(definition.grant)) return '当前账号没有审批权限，请由独立审批人操作。';
        return '请先运行并通过全部试例。';
      }
      if (definition.action === 'publish' && (current.status !== 'approved' || !current.approval)) {
        if (!sessionActions.includes(definition.grant)) return '当前账号没有发布权限。';
        return '请先通过试例，再由独立审批人批准此版本。';
      }
      if (current.allowed_actions.includes(definition.grant)) return undefined;
      if (!sessionActions.includes(definition.grant)) return `当前账号没有${definition.permission}权限。`;
      if (definition.action === 'approve') return '需由未参与编写或修改的审批人批准；权限如有变化，请刷新。';
      return '当前不可操作，请刷新后核对权限与配置状态。';
    };
    const explanation = reason();
    return {...definition, disabled: explanation !== undefined, reason: explanation};
  });
}
