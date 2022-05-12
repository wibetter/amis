import isObjectByLodash from 'lodash/isObject';
import isString from 'lodash/isString';
import isArray from 'lodash/isArray';
import isBoolean from 'lodash/isBoolean';
import {
  getVariable,
  isPureVariable,
  resolveVariable,
  resolveVariableAndFilter,
  evaluate
} from 'amis-formula';

import {filter} from './tpl';
import {getFilters} from './tpl-builtin';

/**
 * formulaExec 运算器：根据当前字符串类型执行对应运算，也可按指定执行模式执行运算
 * 
 * 运算模式（execMode）支持以下取值: 
 * 1. tpl: 按模板字符串执行（JavaScript 模板引擎），比如：Hello ${amisUser.email}、<h1>Hello</h1>, <span>${amisUser.email}</span>；
 *    备注: 在模板中可以自由访问变量，详细请见：https://www.lodashjs.com/docs/lodash.template；
 * 2. formula: 按新版公式表达式执行，用于执行 ${ xxx } 格式的表达式；
 *    支持从window、localStorage、sessionStorage获取数据，比如：${num1 + 2}、${ls:env}、${window:document}、${window:document.URL}、${amisUser.email}；
 *    详细请见：https://aisuda.bce.baidu.com/amis/zh-CN/docs/concepts/data-mapping#namespace
 * 3. evalFormula: 按新版公式表达式执行，用于执行 非${ xxx } 格式的表达式（evalMode 为 true，不用 ${} 包裹也可以执行），功能同 formula 运算模式；
 * 4. js: 按Javascript执行，表达式中可以通过data.xxx来获取指定数据，并且支持简单运算；
 *    比如：data.num1 + 2、this.num1 + 2、num1 + 2；（备注：三个表达式是等价的，这里的 this 就是 data。）
 * 5. var: 以此字符串作为key值从当前数据域data中获取数值；性能最高（运行期间不会生成ast和表达式运算）；
 * 
 * 备注1: 当execMode设置为true时，不用 ${} 包裹也可以执行表达式；
 * 备注2: 当 execMode 为true时，或者不设置 execMode（execMode 为 undefined 或者 null），OpenFormulaExecEvalModeStatus 为 true 时，会识别以特殊字符开头的表达式，
 *   其可识别的特殊前缀如下:
 *    1. 以'raw:'开头则直接返回原始字符串（返回前会剔除'raw:'）；
 *    2. 以'='开头则按新版公式表达式执行，同 formula 运算模式；
 *    3. 以`${formulaKey}:`开头，会使用 formulaExec[formulaKey] 运算模式。
 *    4. 以 " 开头，" 结尾，或者 以 ' 开头，' 结尾，则直接输出里面的字符串内容；
 * 备注3: OpenFormulaExecEvalModeStatus 用于 控制 formulaExec execMode 的默认值，设置为 true 时，默认非 ${ xxx } 格式也启动表达式运算器；
 * 备注4: 用户也可以使用 registerFormulaExec 注册一个自定义运算器；
 * 备注5: 模板字符串 和 Javascript 模板引擎 不可以交叉使用；
 * 备注6: amis 现有的 evalFormula 方法，可执行 ${} 格式类表达式，但不支持 filter 过滤器，所以这里用 resolveValueByName 实现；
 * 备注7: 后续可以考虑将 amis现有的运算器都放这里管理，充当统一的运算器入口。
 */

// 缓存，用于提升性能
const FORMULA_EVAL_CACHE: {[key: string]: Function} = {};
 
/**
 * 用于存储当前可用运算器，默认支持 tpl、formula、js、var 四种类型运算器
 * 备注：在这里统一参数。
 */
export const FormulaExec: {
  [key: string]: Function
} = {
  'tpl': (expression: string, data?: object) => {
    const curData = data || {};
    return filter(expression, curData);
  },
  'formula': (expression: string, data?: object) => {
    // 邮箱格式直接返回，后续需要在 amis-formula 中处理
    if (/^\$\{([a-zA-Z0-9_-])+@([a-zA-Z0-9_-])+((.[a-zA-Z0-9_-]{2,3}){1,2})\}$/.test(expression)) {
      return expression.substring(2, expression.length - 1); // 剔除前后特殊字符
    }
    const curData = data || {};
    let result = undefined;
    try {
      // 执行 ${} 格式类表达式，且支持 filter 过滤器。（备注: isPureVariable 可用于判断是否有 过滤器。）
      result = isPureVariable(expression) ? resolveVariableAndFilter(expression, data) : resolveVariable(expression, data);
    } catch (e) {
      console.warn('[formula]表达式执行异常，当前表达式: ', expression, '，当前上下文数据: ', data);
      return expression;
    }
    // 备注: 此处不用 result ?? expression 是为了避免 没有对应结果时直接显示 expression: ${xxx}
    return result;
  },
  'evalFormula': (expression: string, data?: object) => {
    const curData = data || {};
    let result = undefined;
    try {
      result = evaluate(expression, curData, {
        evalMode: true, // evalMode 为 true 时，不用 ${} 包裹也可以执行，
        allowFilter: true // 支持 filter 过滤器
      });
    } catch (e) {
      console.warn('[evalFormula]表达式执行异常，当前表达式: ', expression, '，当前上下文数据: ', data);
      return expression;
    }
    return result ?? expression;
  },
  'js': (expression: string, data?: object) => {
    let debug = false;
    const idx = expression.indexOf('debugger');
    if (~idx) {
      debug = true;
      expression = expression.replace(/debugger;?/, '');
    }

    let fn;
    if (expression in FORMULA_EVAL_CACHE) {
      fn = FORMULA_EVAL_CACHE[expression];
    } else {
      fn = new Function(
        'data',
        'utils',
        `with(data) {${debug ? 'debugger;' : ''}return (${expression});}`
      );
      FORMULA_EVAL_CACHE[expression] = fn;
    }

    data = data || {};

    let curResult = undefined;
    try {
      curResult = fn.call(data, data, getFilters());
    } catch (e) {
      console.warn('[formula:js]表达式执行异常，当前表达式: ', expression, '，当前上下文数据: ', data);
      return expression;
    }
    return curResult;
  },
  'var': (expression: string, data?: object) => {
    const curData = data || {};
    const result = getVariable(curData, expression); // 不支持过滤器
    return result ?? expression;
  },
};

// 用于 控制 formulaExec execMode 的默认值，默认为 true 时，非 ${ xxx } 格式也启动表达式运算器
let FormulaExecEvalModeDefaultStatus = true;
 
export function updateFormulaExecEvalModeDefaultStatus(evalMode: boolean) {
  FormulaExecEvalModeDefaultStatus = evalMode;
}

export function formulaExec(value: any, data: any, execMode?: string | boolean) {
  if (!value) {
    return '';
  }
  let OpenFormulaExecEvalMode = FormulaExecEvalModeDefaultStatus;
  let curExecMode = '';
  if (isBoolean(execMode)) {
    // OpenFormulaExecEvalMode 设置为 true 后，非 ${ xxx } 格式也使用表达式运算器
    OpenFormulaExecEvalMode = execMode;
  } else if (isString(execMode)) {
    // 指定 execMode 可以直接选用对应的运算器
    curExecMode = execMode;
  }
  if (isObjectByLodash(value) || isArray(value) || !isString(value)) {
    // 非字符串类型，直接返回，比如：boolean、number类型、Object、Array类型
    return value;
  } else if (curExecMode && FormulaExec[curExecMode]) {
    return FormulaExec[curExecMode];
  }

  const curValue = value.trim(); // 剔除前后空格
  const formulaKey = catchFormulaExecSign(curValue);

  // OpenFormulaExecEvalMode 为 true 时，非 ${ xxx } 格式也会尝试使用表达式运算器
  if (OpenFormulaExecEvalMode && curValue.startsWith('raw:')) {
    return curValue.substring(4);
  } else if (OpenFormulaExecEvalMode && curValue.startsWith('=')) {
    // 以'='开头启动 evalFormula 运算器
    const curValueTemp = curValue.substring(1);
    return FormulaExec['evalFormula'](curValueTemp, data);
  } else if (OpenFormulaExecEvalMode && formulaKey) {
    const curExpression = catchFormulaExecExpression(curValue, formulaKey);
    return FormulaExec[formulaKey](curExpression, data);
  } else if (OpenFormulaExecEvalMode && /^[0-9a-zA-z_]+$/.test(curValue)) {
    // 普通字符串类型（非表达式），先试一下从上下文中获取数据
    const curValueTemp = FormulaExec['var'](curValue, data);
    // 备注: 其他特殊格式，比如邮箱、日期
    return curValueTemp ?? curValue;
  } else if (curValue.startsWith('${') && curValue.endsWith('}')) {
    // ${ xxx } 格式 使用 formula 表达式运算器
    return FormulaExec['formula'](curValue, data);
  } else if (/(\${).+(\})/.test(curValue)) {
    // 包含 ${ xxx } 则使用 tpl 运算器
    return FormulaExec['tpl'](curValue, data);
  } else if (OpenFormulaExecEvalMode) {
    return FormulaExec['evalFormula'](curValue, data); // 不用 ${} 包裹也可以执行表达式
  } else {
    return curValue;
  }
}

// 用于注册自定义 formulaExec 运算器
export function registerFormulaExec(execMode: string, formulaExec: Function) {
  if (FormulaExec[execMode]) {
    console.error(`registerFormulaExec: 运算器注册失败，存在同名运算器（$(execMode)）。`);
  } else {
    FormulaExec[execMode] = formulaExec;
  }
}

function catchFormulaExecSign(expression: string): string {
  if (expression && FormulaExec) {
    for(let index = 0, curFormulaKeys = Object.keys(FormulaExec), size = curFormulaKeys.length; index < size; index++) {
      const formulaKey = curFormulaKeys[index];
      if (expression.startsWith(`${formulaKey}:`)) {
        return formulaKey;
      }
    }
  }
  return '';
}

function catchFormulaExecExpression(expression: string, formulaKey: string): string {
  if (expression && formulaKey) {
    return expression.substring(formulaKey.length + 1);
  }
  return '';
}

// 用于判断是否是普通数值: 
export function isPureValue(value: any) {
  if (!isString(value)) {
    // 非字符串类型，比如：Object、Array类型、boolean、number类型
    return true;
  } else if (/^(\d{4})\-(\d{2})\-(\d{2})[ T](\d{2})(?:\:\d{2}|:(\d{2}):(\d{2}))(\+(\d{2}):(\d{2}))?$/.test(value) ||
    /^(\d{4})\-(\d{2})\-(\d{2})$/.test(value) ||
    /^(\d{2})(?:\:\d{2}|:(\d{2}):(\d{2}))$/.test(value) ||
    /^\$\{([a-zA-Z0-9_-])+@([a-zA-Z0-9_-])+((.[a-zA-Z0-9_-]{2,3}){1,2})\}$/.test(value)
  ) {
    // 日期类型、邮箱类型
    return true;
  } else {
    return false;
  }
}