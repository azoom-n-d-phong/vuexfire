/*!
 * vuexfirestore v0.0.1
 * (c) 2018 
 * Released under the MIT License.
 */
function createSnapshot(doc) {
  // defaults everything to false, so no need to set
  return Object.defineProperty(doc.data(), "id", {
    value: doc.id
  });
}

var isObject = function (o) { return o && typeof o === "object"; };
var isTimestamp = function (o) { return o.toDate; };
var isRef = function (o) { return o && o.onSnapshot; };

function extractRefs(doc, oldDoc, path, result) {
  if ( path === void 0 ) path = "";
  if ( result === void 0 ) result = [{}, {}];

  // must be set here because walkGet can return null or undefined
  oldDoc = oldDoc || {};
  var idDescriptor = Object.getOwnPropertyDescriptor(doc, "id");
  if (idDescriptor && !idDescriptor.enumerable) {
    Object.defineProperty(result[0], "id", idDescriptor);
  }
  return Object.keys(doc).reduce(function (tot, key) {
    var ref = doc[key];
    // if it's a ref
    if (isRef(ref)) {
      tot[0][key] = oldDoc[key] || ref.path;
      tot[1][path + key] = ref;
    } else if (Array.isArray(ref)) {
      tot[0][key] = Array(ref.length).fill(null);
      extractRefs(ref, oldDoc[key], path + key + ".", [tot[0][key], tot[1]]);
    } else if (
      ref == null ||
      // Firestore < 4.13
      ref instanceof Date ||
      isTimestamp(ref) ||
      (ref.longitude && ref.latitude) // GeoPoint
    ) {
      tot[0][key] = ref;
    } else if (isObject(ref)) {
      tot[0][key] = {};
      extractRefs(ref, oldDoc[key], path + key + ".", [tot[0][key], tot[1]]);
    } else {
      tot[0][key] = ref;
    }
    return tot;
  }, result);
}

function callOnceWithArg(fn, argFn) {
  var called;
  return function () {
    if (!called) {
      called = true;
      return fn(argFn());
    }
  };
}

function walkGet(obj, path) {
  return path.split(".").reduce(function (target, key) { return target[key]; }, obj);
}

function walkSet(obj, path, value) {
  // path can be a number
  var keys = ("" + path).split(".");
  var key = keys.pop();
  var target = keys.reduce(function (target, key) { return target[key]; }, obj);
  // global isFinite is different from Number.isFinite
  // it converts values to numbers
  if (isFinite(key)) { target.splice(key, 1, value); }
  else { target[key] = value; }
}

var VUEXFIRE_SET_VALUE = "vuexfire/SET_VALUE";
var VUEXFIRE_ARRAY_ADD = "vuexfire/ARRAY_ADD";
var VUEXFIRE_ARRAY_REMOVE = "vuexfire/ARRAY_REMOVE";

var obj;

var mutations = ( obj = {}, obj[VUEXFIRE_SET_VALUE] = function (state, ref) {
    var path = ref.path;
    var target = ref.target;
    var data = ref.data;

    walkSet(target, path, data);
    // state[key] = record
  }, obj[VUEXFIRE_ARRAY_ADD] = function (state, ref) {
    var newIndex = ref.newIndex;
    var data = ref.data;
    var target = ref.target;

    target.splice(newIndex, 0, data);
  }, obj[VUEXFIRE_ARRAY_REMOVE] = function (state, ref) {
    var oldIndex = ref.oldIndex;
    var target = ref.target;

    return target.splice(oldIndex, 1)[0];
  }, obj );

var commitOptions = { root: true };
// Firebase binding
var subscriptions = [];
var defaultOptions = {
  maxRefDepth: 2,
  limit: 4,
  orderBy: null,
  orderDirection: null
};
function bindDocument(ref$1) {
  var vm = ref$1.vm;
  var key = ref$1.key;
  var docRef = ref$1.docRef;
  var commit = ref$1.commit;

  var target = walkGet(vm, key);
  var ref = docRef.onSnapshot(function (doc) {
    var changedIndex = subscriptions[key].refList.findIndex(
      function (refListItem) { return refListItem.id === doc.id; }
    );
    if (doc.exists) {
      var data = Object.assign({}, { docId: doc.id }, doc.data());
      // add new doc
      if (changedIndex === -1) {
        subscriptions[key].refList.push({
          id: doc.id,
          ref: ref
        });
        commit(
          VUEXFIRE_ARRAY_ADD,
          {
            target: target,
            newIndex: subscriptions[key].refList.length,
            data: data
          },
          commitOptions
        );
      } else {
        // edit existing doc
        commit(
          VUEXFIRE_ARRAY_REMOVE,
          { target: target, oldIndex: changedIndex },
          commitOptions
        );
        commit(
          VUEXFIRE_ARRAY_ADD,
          { target: target, newIndex: changedIndex, data: data },
          commitOptions
        );
      }
    } else {
      // delete doc
      commit(
        VUEXFIRE_ARRAY_REMOVE,
        { target: target, oldIndex: changedIndex },
        commitOptions
      );
      // unsubscribe deleted doc
      subscriptions[key].refList.splice(changedIndex, 1)[0].ref();
    }
  });
}
function bindCollection(ref) {
  var vm = ref.vm;
  var key = ref.key;
  var collection = ref.collection;
  var commit = ref.commit;
  var resolve = ref.resolve;
  var reject = ref.reject;

  var isLoaded;
  collection = collection.limit(subscriptions[key].options.limit);
  // get all doc here and save into subscription folder
  var unbind = collection.onSnapshot(function (ref) {
    var docChanges =
      typeof ref.docChanges === "function" ? ref.docChanges() : ref.docChanges;

    if (!isLoaded && docChanges.length) {
      docChanges.forEach(function (change) {
        // only add the new doc here
        var isAdded = subscriptions[key].refList.some(
          function (ref) { return ref.id === change.doc.id; }
        );
        // doc not exists in state yet
        if (change.type === "added" && !isAdded) {
          bindDocument({ vm: vm, key: key, docRef: change.doc.ref, commit: commit });
        }
      });
    }
    // if the pagination mode is on, then ignore all the new node after the first time
    // also, unsubscribe for new node
    isLoaded = true;
    unbind();
    // add next ref here
    if (docChanges.length) {
      var nextDoc = docChanges[docChanges.length - 1];
      subscriptions[key].nextRef = subscriptions[key].ref.startAfter(
        nextDoc.doc
      );
    }
    // resolves when array is empty
    if (!docChanges.length) {
      resolve();
    }
  }, reject);
  return function () {
    unbind();
    subscriptions[key].refList.forEach(function (refListItem) { return refListItem.ref(); });
  };
}
function bind(ref$1, options) {
  var state = ref$1.state;
  var commit = ref$1.commit;
  var key = ref$1.key;
  var ref = ref$1.ref;
  if ( options === void 0 ) options = {};

  // merge the options here
  options = Object.assign({}, defaultOptions, options);
  // create an entry for the collection
  // actually bind should be called once (!?)
  if (!subscriptions[key]) {
    subscriptions[key] = {
      ref: ref,
      refList: [],
      nextRef: null,
      options: options
    };
  }

  return new Promise(function (resolve, reject) {
    // is collection
    if (subscriptions[key].ref.where) {
      return bindCollection(
        {
          vm: state,
          key: key,
          collection: ref,
          commit: commit,
          resolve: resolve,
          reject: reject
        },
        subscriptions[key].options
      );
    }
    resolve();
  });
}
function unbind(ref) {
  var commit = ref.commit;
  var key = ref.key;

  var sub = subscriptions[key];
  if (!sub) { return; }
  if (sub[key].nextRef) { sub[key].nextRef(); }
  sub[key].refList.forEach(function (ref) { return ref(); });
  delete sub[key];
}
function fetchNextRef(ref) {
  var state = ref.state;
  var commit = ref.commit;
  var key = ref.key;

  if (subscriptions[key].nextRef) {
    return new Promise(function (resolve, reject) {
      return bindCollection({
        vm: state,
        key: key,
        collection: subscriptions[key].nextRef,
        commit: commit,
        resolve: resolve,
        reject: reject
      });
    });
  }
  return new Promise(function () {});
}

var firebaseMutations = {};
var commitOptions$1 = { root: true };

Object.keys(mutations).forEach(function (type) {
  // the { commit, state, type, ...payload } syntax is not supported by buble...
  firebaseMutations[type] = function (_, context) {
    mutations[type](context.state, context);
  };
});

function unsubscribeAll(subs) {
  for (var sub in subs) {
    subs[sub].unsub();
  }
}

// NOTE not convinced by the naming of subscribeToRefs and subscribeToDocument
// first one is calling the other on every ref and subscribeToDocument may call
// updateDataFromDocumentSnapshot which may call subscribeToRefs as well
function subscribeToRefs(
  ref,
  options
) {
  var subs = ref.subs;
  var refs = ref.refs;
  var target = ref.target;
  var path = ref.path;
  var data = ref.data;
  var depth = ref.depth;
  var commit = ref.commit;
  var resolve = ref.resolve;

  var refKeys = Object.keys(refs);
  var missingKeys = Object.keys(subs).filter(
    function (refKey) { return refKeys.indexOf(refKey) < 0; }
  );
  // unbind keys that are no longer there
  missingKeys.forEach(function (refKey) {
    subs[refKey].unsub();
    delete subs[refKey];
  });
  console.log(refKeys);
  if (!refKeys.length || ++depth > options.maxRefDepth) { return resolve(path); }

  var resolvedCount = 0;
  var totalToResolve = refKeys.length;
  var validResolves = Object.create(null);
  function deepResolve(key) {
    if (key in validResolves) {
      if (++resolvedCount >= totalToResolve) { resolve(path); }
    }
  }

  refKeys.forEach(function (refKey) {
    var sub = subs[refKey];
    var ref = refs[refKey];
    var docPath = path + "." + refKey;

    validResolves[docPath] = true;

    // unsubscribe if bound to a different ref
    if (sub) {
      if (sub.path !== ref.path) { sub.unsub(); }
      // if has already be bound and as we always walk the objects, it will work
      else { return; }
    }

    subs[refKey] = {
      unsub: subscribeToDocument(
        {
          ref: ref,
          target: target,
          path: docPath,
          depth: depth,
          commit: commit,
          resolve: deepResolve.bind(null, docPath)
        },
        options
      ),
      path: ref.path
    };
  });
}

function bindCollection$1(
  ref,
  options
) {
  var vm = ref.vm;
  var key = ref.key;
  var collection = ref.collection;
  var commit = ref.commit;
  var resolve = ref.resolve;
  var reject = ref.reject;

  commit(
    VUEXFIRE_SET_VALUE,
    {
      path: key,
      target: vm,
      data: []
    },
    commitOptions$1
  );
  var target = walkGet(vm, key);
  var originalResolve = resolve;
  var isResolved;

  // contain ref subscriptions of objects
  // arraySubs is a mirror of array
  var arraySubs = [];

  var change = {
    added: function (ref) {
      var newIndex = ref.newIndex;
      var doc = ref.doc;

      arraySubs.splice(newIndex, 0, Object.create(null));
      var subs = arraySubs[newIndex];
      var snapshot = createSnapshot(doc);
      var ref$1 = extractRefs(snapshot);
      var data = ref$1[0];
      var refs = ref$1[1];
      commit(VUEXFIRE_ARRAY_ADD, { target: target, newIndex: newIndex, data: data }, commitOptions$1);
      subscribeToRefs(
        {
          data: data,
          refs: refs,
          subs: subs,
          target: target,
          path: newIndex,
          depth: 0,
          commit: commit,
          resolve: resolve.bind(null, doc)
        },
        options
      );
    },
    modified: function (ref) {
      var oldIndex = ref.oldIndex;
      var newIndex = ref.newIndex;
      var doc = ref.doc;

      var subs = arraySubs.splice(oldIndex, 1)[0];
      arraySubs.splice(newIndex, 0, subs);
      // const oldData = array.splice(oldIndex, 1)[0]
      var oldData = commit(
        VUEXFIRE_ARRAY_REMOVE,
        { target: target, oldIndex: oldIndex },
        commitOptions$1
      );
      var snapshot = createSnapshot(doc);
      var ref$1 = extractRefs(snapshot, oldData);
      var data = ref$1[0];
      var refs = ref$1[1];
      // array.splice(newIndex, 0, data)
      commit(VUEXFIRE_ARRAY_ADD, { target: target, newIndex: newIndex, data: data }, commitOptions$1);
      subscribeToRefs(
        {
          data: data,
          refs: refs,
          subs: subs,
          target: target,
          path: newIndex,
          depth: 0,
          commit: commit,
          resolve: resolve
        },
        options
      );
    },
    removed: function (ref) {
      var oldIndex = ref.oldIndex;

      // array.splice(oldIndex, 1)
      commit(VUEXFIRE_ARRAY_REMOVE, { target: target, oldIndex: oldIndex }, commitOptions$1);
      unsubscribeAll(arraySubs.splice(oldIndex, 1)[0]);
    }
  };

  var unbind$$1 = collection.onSnapshot(function (ref) {
    // console.log('pending', metadata.hasPendingWrites)
    // docs.forEach(d => console.log('doc', d, '\n', 'data', d.data()))
    // NOTE this will only be triggered once and it will be with all the documents
    // from the query appearing as added
    // (https://firebase.google.com/docs/firestore/query-data/listen#view_changes_between_snapshots)
    var docChanges =
      typeof ref.docChanges === "function" ? ref.docChanges() : ref.docChanges;

    if (!isResolved && docChanges.length) {
      // isResolved is only meant to make sure we do the check only once
      isResolved = true;
      var count = 0;
      var expectedItems = docChanges.length;
      var validDocs = docChanges.reduce(function (dict, ref) {
        var doc = ref.doc;

        dict[doc.id] = false;
        return dict;
      }, Object.create(null));
      resolve = function (ref) {
        var id = ref.id;

        if (id in validDocs) {
          if (++count >= expectedItems) {
            originalResolve(vm[key]);
            // reset resolve to noop
            resolve = function (_) {};
          }
        }
      };
    }
    docChanges.forEach(function (c) {
      change[c.type](c);
    });

    // resolves when array is empty
    if (!docChanges.length) { resolve(); }
  }, reject);

  return function () {
    unbind$$1();
    arraySubs.forEach(unsubscribeAll);
  };
}

function updateDataFromDocumentSnapshot(
  ref,
  options
) {
  var snapshot = ref.snapshot;
  var target = ref.target;
  var path = ref.path;
  var subs = ref.subs;
  var depth = ref.depth; if ( depth === void 0 ) depth = 0;
  var commit = ref.commit;
  var resolve = ref.resolve;

  var ref$1 = extractRefs(snapshot, walkGet(target, path));
  var data = ref$1[0];
  var refs = ref$1[1];
  commit(
    VUEXFIRE_SET_VALUE,
    {
      path: path,
      target: target,
      data: data
    },
    commitOptions$1
  );
  subscribeToRefs(
    {
      data: data,
      subs: subs,
      refs: refs,
      target: target,
      path: path,
      depth: depth,
      commit: commit,
      resolve: resolve
    },
    options
  );
}

function subscribeToDocument(
  ref$1,
  options
) {
  var ref = ref$1.ref;
  var target = ref$1.target;
  var path = ref$1.path;
  var depth = ref$1.depth;
  var commit = ref$1.commit;
  var resolve = ref$1.resolve;

  var subs = Object.create(null);
  var unbind$$1 = ref.onSnapshot(function (doc) {
    if (doc.exists) {
      updateDataFromDocumentSnapshot(
        {
          snapshot: createSnapshot(doc),
          target: target,
          path: path,
          subs: subs,
          depth: depth,
          commit: commit,
          resolve: resolve
        },
        options
      );
    } else {
      commit(
        VUEXFIRE_SET_VALUE,
        {
          target: target,
          path: path,
          data: null
        },
        commitOptions$1
      );
      resolve(path);
    }
  });

  return function () {
    unbind$$1();
    unsubscribeAll(subs);
  };
}

function bindDocument$1(ref, options) {
  var vm = ref.vm;
  var key = ref.key;
  var document = ref.document;
  var commit = ref.commit;
  var resolve = ref.resolve;
  var reject = ref.reject;

  // TODO warning check if key exists?
  // const boundRefs = Object.create(null)

  var subs = Object.create(null);
  // bind here the function so it can be resolved anywhere
  // this is specially useful for refs
  // TODO use walkGet?
  resolve = callOnceWithArg(resolve, function () { return vm[key]; });
  var unbind$$1 = document.onSnapshot(function (doc) {
    if (doc.exists) {
      updateDataFromDocumentSnapshot(
        {
          snapshot: createSnapshot(doc),
          target: vm,
          path: key,
          subs: subs,
          commit: commit,
          resolve: resolve
        },
        options
      );
    } else {
      resolve();
    }
  }, reject);

  return function () {
    unbind$$1();
    unsubscribeAll(subs);
  };
}

// Firebase binding
var subscriptions$1 = new WeakMap();

function bind$1(ref$1, options) {
  var state = ref$1.state;
  var commit = ref$1.commit;
  var key = ref$1.key;
  var ref = ref$1.ref;
  if ( options === void 0 ) options = { maxRefDepth: 2 };

  // TODO check ref is valid
  // TODO check defined in state
  var sub = subscriptions$1.get(commit);
  if (!sub) {
    sub = Object.create(null);
    subscriptions$1.set(commit, sub);
  }

  // unbind if ref is already bound
  if (key in sub) {
    unbind$1({ commit: commit, key: key });
  }

  return new Promise(function (resolve, reject) {
    sub[key] = ref.where
      ? bindCollection$1(
          {
            vm: state,
            key: key,
            collection: ref,
            commit: commit,
            resolve: resolve,
            reject: reject
          },
          options
        )
      : bindDocument$1(
          {
            vm: state,
            key: key,
            document: ref,
            commit: commit,
            resolve: resolve,
            reject: reject
          },
          options
        );
  });
}

function unbind$1(ref) {
  var commit = ref.commit;
  var key = ref.key;

  var sub = subscriptions$1.get(commit);
  if (!sub) { return; }
  // TODO dev check before
  sub[key]();
  delete sub[key];
}

function firebaseAction(action) {
  return function firebaseEnhancedActionFn(context, payload) {
    // get the local state and commit. These may be bound to a module
    var state = context.state;
    var commit = context.commit;
    context.bindFirebaseRef = function (key, ref, options) {
        if ( options === void 0 ) options = {};

        return bind$1({ state: state, commit: commit, key: key, ref: ref }, options);
    };
    context.unbindFirebaseRef = function (key) { return unbind$1({ commit: commit, key: key }); };
    context.bindMultipageRef = function (key, ref, options) {
        if ( options === void 0 ) options = {};

        return bind({ state: state, commit: commit, key: key, ref: ref }, options);
    };
    context.unbindMultipageRef = function (key) { return unbind({ commit: commit, key: key }); };
    context.fetchNextMultipageRef = function (key) { return fetchNextRef({ state: state, commit: commit, key: key }); };
    return action(context, payload);
  };
}

export { firebaseMutations, firebaseAction };
