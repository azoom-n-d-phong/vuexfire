import { createSnapshot, extractRefs, callOnceWithArg, walkGet } from "./utils";
import {
  VUEXFIRE_SET_VALUE,
  VUEXFIRE_ARRAY_ADD,
  VUEXFIRE_ARRAY_REMOVE
} from "./types";

const commitOptions = { root: true };

function unsubscribeAll(subs) {
  for (const sub in subs) {
    subs[sub].unsub();
  }
}

// NOTE not convinced by the naming of subscribeToRefs and subscribeToDocument
// first one is calling the other on every ref and subscribeToDocument may call
// updateDataFromDocumentSnapshot which may call subscribeToRefs as well
function subscribeToRefs(
  { subs, refs, target, path, data, depth, commit, resolve },
  options
) {
  const refKeys = Object.keys(refs);
  const missingKeys = Object.keys(subs).filter(
    refKey => refKeys.indexOf(refKey) < 0
  );
  // unbind keys that are no longer there
  missingKeys.forEach(refKey => {
    subs[refKey].unsub();
    delete subs[refKey];
  });
  if (!refKeys.length || ++depth > options.maxRefDepth) return resolve(path);

  let resolvedCount = 0;
  const totalToResolve = refKeys.length;
  const validResolves = Object.create(null);
  function deepResolve(key) {
    if (key in validResolves) {
      if (++resolvedCount >= totalToResolve) resolve(path);
    }
  }

  refKeys.forEach(refKey => {
    const sub = subs[refKey];
    const ref = refs[refKey];
    const docPath = `${path}.${refKey}`;

    validResolves[docPath] = true;

    // unsubscribe if bound to a different ref
    if (sub) {
      if (sub.path !== ref.path) sub.unsub();
      // if has already be bound and as we always walk the objects, it will work
      else return;
    }

    subs[refKey] = {
      unsub: subscribeToDocument(
        {
          ref,
          target,
          path: docPath,
          depth,
          commit,
          resolve: deepResolve.bind(null, docPath)
        },
        options
      ),
      path: ref.path
    };
  });
}

function bindCollection(
  { vm, key, collection, commit, pos, resolve, reject },
  options
) {
  const target = walkGet(vm, key);
  const originalResolve = resolve;
  let isResolved;

  // contain ref subscriptions of objects
  // arraySubs is a mirror of array
  const arraySubs = [];

  const change = {
    added: ({ newIndex, doc }, querySnapshot) => {
      const insertIndex =
        newIndex + pos * subscriptions[key].options.pagination;
      arraySubs.splice(newIndex, 0, Object.create(null));
      const subs = arraySubs[newIndex];
      const snapshot = createSnapshot(doc);
      const [data, refs] = extractRefs(snapshot);
      commit(
        VUEXFIRE_ARRAY_ADD,
        { target, newIndex: insertIndex, data },
        commitOptions
      );

      subscribeToRefs(
        {
          data,
          refs,
          subs,
          target,
          path: insertIndex,
          depth: 0,
          commit,
          resolve: resolve.bind(null, doc)
        },
        options
      );
      if (insertIndex === target.length - 1)
        subscriptions[key].nextRefStartAfterDoc = isWorkingWithCollection
          ? querySnapshot.docs[querySnapshot.size - 1]
          : null;
    },
    modified: ({ oldIndex, newIndex, doc }) => {
      const changedIndex =
        oldIndex + pos * subscriptions[key].options.pagination;
      const newInsertIndex =
        newIndex + pos * subscriptions[key].options.pagination;
      const subs = arraySubs.splice(oldIndex, 1)[0];
      arraySubs.splice(newIndex, 0, subs);
      // const oldData = array.splice(oldIndex, 1)[0]
      const oldData = commit(
        VUEXFIRE_ARRAY_REMOVE,
        { target, oldIndex: changedIndex },
        commitOptions
      );
      const snapshot = createSnapshot(doc);
      const [data, refs] = extractRefs(snapshot, oldData);
      // array.splice(newIndex, 0, data)
      commit(
        VUEXFIRE_ARRAY_ADD,
        { target, newIndex: newInsertIndex, data },
        commitOptions
      );
      subscribeToRefs(
        {
          data,
          refs,
          subs,
          target,
          path: newIndex,
          depth: 0,
          commit,
          resolve
        },
        options
      );
    },
    removed: ({ oldIndex }) => {
      // array.splice(oldIndex, 1)
      const removedIndex =
        oldIndex + pos * subscriptions[key].options.pagination;
      commit(
        VUEXFIRE_ARRAY_REMOVE,
        { target, oldIndex: removedIndex },
        commitOptions
      );
      unsubscribeAll(arraySubs.splice(oldIndex, 1)[0]);
    }
  };

  const unbind = collection.onSnapshot(ref => {
    // console.log('pending', metadata.hasPendingWrites)
    // docs.forEach(d => console.log('doc', d, '\n', 'data', d.data()))
    // NOTE this will only be triggered once and it will be with all the documents
    // from the query appearing as added
    // (https://firebase.google.com/docs/firestore/query-data/listen#view_changes_between_snapshots)
    const docChanges =
      typeof ref.docChanges === "function" ? ref.docChanges() : ref.docChanges;

    if (!isResolved && docChanges.length) {
      // isResolved is only meant to make sure we do the check only once
      isResolved = true;
      let count = 0;
      const expectedItems = docChanges.length;
      const validDocs = docChanges.reduce((dict, { doc }) => {
        dict[doc.id] = false;
        return dict;
      }, Object.create(null));
      subscriptions[key].nextRefStartAfterDoc = isWorkingWithCollection(
        collection
      )
        ? ref.docs[ref.size - 1]
        : null;
      resolve = ({ id }) => {
        if (id in validDocs) {
          if (++count >= expectedItems) {
            originalResolve(vm[key]);
            // reset resolve to noop
            resolve = _ => {};
          }
        }
      };
    }
    docChanges.forEach(c => {
      change[c.type](c, ref);
    });

    // resolves when array is empty
    if (!docChanges.length) {
      subscriptions[key].isCompleted = true;
      resolve();
    }
  }, reject);

  return () => {
    unbind();
    arraySubs.forEach(unsubscribeAll);
  };
}

function updateDataFromDocumentSnapshot(
  { snapshot, target, path, subs, depth = 0, commit, resolve },
  options
) {
  const [data, refs] = extractRefs(snapshot, walkGet(target, path));
  commit(
    VUEXFIRE_SET_VALUE,
    {
      path,
      target,
      data
    },
    commitOptions
  );
  subscribeToRefs(
    {
      data,
      subs,
      refs,
      target,
      path,
      depth,
      commit,
      resolve
    },
    options
  );
}

function subscribeToDocument(
  { ref, target, path, depth, commit, resolve },
  options
) {
  const subs = Object.create(null);
  const unbind = ref.onSnapshot(doc => {
    if (doc.exists) {
      updateDataFromDocumentSnapshot(
        {
          snapshot: createSnapshot(doc),
          target,
          path,
          subs,
          depth,
          commit,
          resolve
        },
        options
      );
    } else {
      commit(
        VUEXFIRE_SET_VALUE,
        {
          target,
          path,
          data: null
        },
        commitOptions
      );
      resolve(path);
    }
  });

  return () => {
    unbind();
    unsubscribeAll(subs);
  };
}

function bindDocument({ vm, key, document, commit, resolve, reject }, options) {
  // TODO warning check if key exists?
  // const boundRefs = Object.create(null)

  const subs = Object.create(null);
  // bind here the function so it can be resolved anywhere
  // this is specially useful for refs
  // TODO use walkGet?
  resolve = callOnceWithArg(resolve, () => vm[key]);
  const unbind = document.onSnapshot(doc => {
    if (doc.exists) {
      updateDataFromDocumentSnapshot(
        {
          snapshot: createSnapshot(doc),
          target: vm,
          path: key,
          subs,
          commit,
          resolve
        },
        options
      );
    } else {
      resolve();
    }
  }, reject);

  return () => {
    unbind();
    unsubscribeAll(subs);
  };
}

// Firebase binding
const subscriptions = [];
const defaultOptions = {
  maxRefDepth: 2,
  multiCollection: false,
  useFirstRefForAddOps: false,
  pagination: 4,
  orderBy: "created_at",
  orderDirection: "asc"
};

export function bind(
  { state, commit, key, ref },
  options = { maxRefDepth: 2 }
) {
  options = { ...defaultOptions, ...options };

  if (!subscriptions[key]) {
    subscriptions[key] = {
      refList: [],
      nextRefStartAfterDoc: null,
      toAddRef: null,
      offset: 0,
      isCompleted: false,
      options
    };
  }
  ref = ref
    .orderBy(options.orderBy, options.orderDirection)
    .limit(options.pagination);
  if (subscriptions[key].nextRefStartAfterDoc) {
    ref = ref.startAfter(subscriptions[key].nextRefStartAfterDoc);
  }

  return new Promise((resolve, reject) => {
    const toBePushedRef = ref.where
      ? bindCollection(
          {
            vm: state,
            key,
            collection: ref,
            commit,
            pos: subscriptions[key].refList.length,
            resolve,
            reject
          },
          options
        )
      : bindDocument(
          {
            vm: state,
            key,
            document: ref,
            commit,
            pos: subscriptions[key].refList.length,
            resolve,
            reject
          },
          options
        );
    subscriptions[key].refList.push(toBePushedRef);
    if (!options.useFirstRefForAddOps)
      subscriptions[key].toAddRef = toBePushedRef;
    else if (!subscriptions[key].toAddRef)
      subscriptions[key].toAddRef = toBePushedRef;
  });
}

export function unbind({ commit, key }) {
  let sub = subscriptions[key];
  if (!sub) return;
  // TODO dev check before
  sub[key].refList.forEach(ref => ref());
  delete sub[key];
}

export function fetchNextRef({ state, commit, key, ref }) {
  const options = subscriptions[key].options;
  if (
    options.multiCollection &&
    subscriptions[key].nextRefStartAfterDoc &&
    !subscriptions[key].isCompleted &&
    isWorkingWithCollection(ref)
  ) {
    // return bind({ state, commit, key, ref });
    return new Promise((resolve, reject) => {
      bind({ state, commit, key, ref })
        .then(resolve)
        .catch(reject);
    });
  } else {
    return new Promise(() => {});
  }
}

function isWorkingWithCollection(ref) {
  return ref.where;
}
