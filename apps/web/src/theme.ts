import type {ThemeConfig} from 'antd';
export const palette = {background: '#F5F5F5', surface: '#FFFFFF', text: '#333333', secondary: '#666666', primary: '#DB0011', border: '#D7D8D6', warning: '#8C5D0A', error: '#B42318', success: '#276449'} as const;
// Brand red marks the brand, the one primary action and the single current item; hover and focus use ink.
export const semantic = {chatUserBackground: '#FCEBED', selection: palette.primary, selectionFill: 'rgba(219, 0, 17, 0.08)', focus: palette.text, hoverBg: '#FAFAFA', candidate: palette.warning, warningBg: '#FFF8E6', error: palette.error} as const;
// Bank V2 compact scale. Source text and extracted values read at 14; work surfaces at 13; secondary at 12.
export const typeScale = {pageTitle: 22, section: 18, subheading: 14, source: 14, body: 13, secondary: 12} as const;
// 36px utility bar + 56px brand and journey bar; the shell measures the real height at runtime.
export const layout = {topbar: 92, utilityBar: 36, brandBar: 56} as const;
export const hsbcThemeMapping = {status: 'user_confirmed', themeVersion: 'hsbc-p1-20261013', layoutRevision: 'ui-uplift-20261120'} as const;
const inkFocus = '0 0 0 2px rgba(51, 51, 51, 0.25)';
export const theme: ThemeConfig = {
  token: {colorPrimary: palette.primary, colorInfo: palette.text, colorInfoBg: palette.background, colorInfoBorder: palette.border, colorSuccess: palette.success, colorText: palette.text, colorTextSecondary: palette.secondary, colorWarning: palette.warning, colorError: palette.error, colorBgLayout: palette.background, colorBgContainer: palette.surface, colorBorder: palette.border, colorLink: palette.text, colorLinkHover: palette.text, colorLinkActive: palette.text, fontFamily: '"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif', fontSize: typeScale.body, fontSizeSM: typeScale.secondary, fontSizeLG: typeScale.subheading, fontSizeHeading1: typeScale.pageTitle, fontSizeHeading2: typeScale.section, fontSizeHeading3: typeScale.subheading, fontSizeHeading4: typeScale.body, fontSizeHeading5: typeScale.body, fontWeightStrong: 500, lineHeight: 1.5, lineWidthFocus: 2, borderRadius: 0, controlHeight: 36, controlHeightLG: 40, controlHeightSM: 28, motion: false},
  components: {
    Table: {headerBg: palette.background, headerColor: palette.secondary, headerSplitColor: 'transparent', headerBorderRadius: 0, rowHoverBg: semantic.hoverBg, cellPaddingBlock: 12, cellFontSize: typeScale.body, cellFontSizeMD: typeScale.body, cellFontSizeSM: typeScale.body},
    Tabs: {inkBarColor: palette.primary, itemSelectedColor: palette.text, itemHoverColor: palette.text, itemActiveColor: palette.text, titleFontSize: typeScale.body, horizontalMargin: '0', horizontalItemGutter: 24, horizontalItemPadding: '12px 0'},
    Button: {fontWeight: 400, contentFontSize: typeScale.body, contentFontSizeLG: typeScale.subheading, contentFontSizeSM: typeScale.secondary, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none', defaultHoverColor: palette.text, defaultHoverBorderColor: palette.text, defaultHoverBg: semantic.hoverBg, defaultActiveColor: palette.text, defaultActiveBorderColor: palette.text, defaultActiveBg: palette.background, textHoverBg: palette.background},
    Form: {labelFontSize: typeScale.body, itemMarginBottom: 20, verticalLabelPadding: '0 0 6px'},
    Input: {inputFontSize: typeScale.body, inputFontSizeLG: typeScale.subheading, inputFontSizeSM: typeScale.secondary, hoverBorderColor: palette.secondary, activeBorderColor: palette.text, activeShadow: inkFocus},
    InputNumber: {inputFontSize: typeScale.body, inputFontSizeLG: typeScale.subheading, inputFontSizeSM: typeScale.secondary, hoverBorderColor: palette.secondary, activeBorderColor: palette.text, activeShadow: inkFocus},
    Select: {optionFontSize: typeScale.body, optionHeight: 32, hoverBorderColor: palette.secondary, activeBorderColor: palette.text, activeOutlineColor: 'rgba(51, 51, 51, 0.25)', optionSelectedBg: palette.background, optionSelectedFontWeight: 500},
    Pagination: {itemActiveColor: palette.text, itemSize: 28},
    Segmented: {itemSelectedColor: palette.text},
    Breadcrumb: {itemColor: palette.secondary, lastItemColor: palette.text, linkColor: palette.secondary, linkHoverColor: palette.text, separatorColor: palette.secondary, fontSize: typeScale.body},
    Alert: {withDescriptionIconSize: 16, withDescriptionPadding: '12px 16px'},
    Modal: {titleFontSize: 20},
  },
};
// Below 620px, text entry keeps 16px so mobile browsers do not zoom the page on focus.
export const narrowEntryTheme: ThemeConfig = {
  components: {Input: {inputFontSize: 16, inputFontSizeLG: 16}, InputNumber: {inputFontSize: 16, inputFontSizeLG: 16}, Select: {fontSize: 16, optionFontSize: 16}},
};
