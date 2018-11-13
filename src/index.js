import * as original from "./original";
import * as multi from "./multi";
import mutations from "./mutations";

export function firebaseAction(action) {
  return function firebaseEnhancedActionFn(context, payload) {
    // get the local state and commit. These may be bound to a module
    const { state, commit } = context;
    context.bindFirebaseRef = (key, ref, options = {}) => {
      if (options.multiCollection) {
        return multi.bind({ state, commit, key, ref }, options);
      } else {
        return original.bind({ state, commit, key, ref }, options);
      }
    };
    context.unbindFirebaseRef = key => {
      if (options.multiCollection) {
        return multi.unbind({ commit, key });
      } else {
        return original.unbind({ commit, key });
      }
    };
    context.fetchNextRef = (key, ref) => {
      return multi.fetchNextRef({ state, commit, key, ref });
    };
    return action(context, payload);
  };
}

// export firebaseMutations
export const firebaseMutations = {};
Object.keys(mutations).forEach(type => {
  // the { commit, state, type, ...payload } syntax is not supported by buble...
  firebaseMutations[type] = (_, context) => {
    mutations[type](context.state, context);
  };
});
